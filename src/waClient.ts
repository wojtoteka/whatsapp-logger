// Uruchomienie przeglądarki i klienta WhatsApp Web.
//
// Jest tu też rzecz, której brakowało poprzedniej wersji: czekanie na to,
// aż WhatsApp faktycznie się zsynchronizuje. Zdarzenie "ready" z biblioteki
// leci, gdy tylko w stronie pojawi się window.Store - a to bywa na długo
// przed wczytaniem książki adresowej. Program brał się wtedy do roboty za
// wcześnie: kontaktów jeszcze nie było, więc foldery czatów nazywały się
// gołymi cyframi z identyfikatora @lid i tak już zostawało.

import fs from 'node:fs';
import path from 'node:path';
import { Client, LocalAuth } from 'whatsapp-web.js';
import type { Config } from './config';
import { describeError, log } from './log';
import type { WaClient } from './types';
import type { WaMessage } from './types';
import { sleep } from './util';

// whatsapp-web.js eksportuje konstruktor w runtime, ale w 1.34.6 deklaracje
// TypeScript opisują Message wyłącznie jako interface. Ten dokładny konstruktor
// jest używany także przez Chat.fetchMessages() w kodzie zainstalowanej wersji.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const HistoryMessage = require('whatsapp-web.js/src/structures/Message') as new (
    client: WaClient,
    data: unknown,
) => WaMessage;

/** Argumenty przeglądarki - te same, które działają na Windowsie i Linuksie. */
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    // Wymagane na serwerach linuksowych, gdzie /dev/shm bywa malutki.
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
];

/** Gdzie szukać Chrome'a, gdy CHROME_PATH nie jest ustawione. */
function chromeCandidates(): string[] {
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA;
        return [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            ...(local ? [`${local}\\Google\\Chrome\\Application\\chrome.exe`] : []),
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ];
    }
    if (process.platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ];
    }
    return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
    ];
}

/**
 * Ścieżka do przeglądarki. Wartość z .env ma pierwszeństwo; gdy wskazuje
 * na coś, czego nie ma, mówimy o tym wprost, zamiast po cichu brać inną.
 */
export function findChrome(configured: string | null): string | null {
    if (configured) {
        if (fs.existsSync(configured)) return configured;
        log.warn(`CHROME_PATH wskazuje na "${configured}", ale tam nic nie ma - szukam sam.`);
    }
    for (const candidate of chromeCandidates()) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

export function createClient(config: Config, rootDir: string): WaClient {
    const chromePath = findChrome(config.chromePath);

    if (chromePath) log.debug(`Przeglądarka: ${chromePath}`);
    else {
        log.warn(
            'Nie znalazłem Chrome ani Chromium - puppeteer spróbuje własnej kopii. ' +
                'Jeśli nie wystartuje, wskaż przeglądarkę w CHROME_PATH w pliku .env.',
        );
    }

    return new Client({
        // Sesja zapisana lokalnie - kod QR skanuje się tylko raz.
        authStrategy: new LocalAuth({ dataPath: path.join(rootDir, '.wwebjs_auth') }),
        puppeteer: {
            headless: config.headless,
            args: PUPPETEER_ARGS,
            ...(chromePath ? { executablePath: chromePath } : {}),
        },
    }) as WaClient;
}

// ─────────────────────────────────────────────────────────────────────────
//  Pełna historia w kontrolowanych paczkach
// ─────────────────────────────────────────────────────────────────────────

export interface FullHistoryScan {
    supported: boolean;
    total: number;
}

/**
 * Ładuje dostępną historię do Store strony WhatsApp Web i zapamiętuje tam
 * uporządkowane referencje. Zweryfikowane dla whatsapp-web.js 1.34.6:
 * Chat.fetchMessages używa dokładnie Store.ConversationMsgs.loadEarlierMsgs.
 */
export async function prepareFullHistoryScan(
    client: WaClient,
    chatId: string,
): Promise<FullHistoryScan> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return { supported: false, total: 0 };

    return page.evaluate(async (id: string): Promise<FullHistoryScan> => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const root = globalThis as any;
        const win = root.window ?? root;
        const store = win.Store;
        if (!win.WWebJS?.getChat || !win.WWebJS?.getMessageModel) {
            return { supported: false, total: 0 };
        }
        if (!store?.ConversationMsgs?.loadEarlierMsgs) {
            return { supported: false, total: 0 };
        }

        const chat = await win.WWebJS.getChat(id, { getAsModel: false });
        if (!chat?.msgs?.getModelsArray) return { supported: false, total: 0 };

        while (true) {
            const loaded = await store.ConversationMsgs.loadEarlierMsgs(chat, chat.msgs);
            if (!loaded?.length) break;
        }

        const messages = chat.msgs
            .getModelsArray()
            .filter((message: any) => !message?.isNotification)
            .sort((a: any, b: any) => {
                const time = Number(a?.t ?? 0) - Number(b?.t ?? 0);
                if (time !== 0) return time;
                return String(a?.id?._serialized ?? a?.id?.id ?? '').localeCompare(
                    String(b?.id?._serialized ?? b?.id?.id ?? ''),
                );
            });
        win.__whatsappLoggerHistoryScan = { chatId: id, messages };
        return { supported: true, total: messages.length };
        /* eslint-enable @typescript-eslint/no-explicit-any */
    }, chatId);
}

/** Zwraca tylko jedną paczkę modeli z przygotowanego skanu. */
export async function readFullHistoryBatch(
    client: WaClient,
    chatId: string,
    offset: number,
    limit: number,
): Promise<WaMessage[]> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return [];

    const models = await page.evaluate(
        (id: string, start: number, count: number): unknown[] => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const root = globalThis as any;
            const win = root.window ?? root;
            const scan = win.__whatsappLoggerHistoryScan;
            if (!scan || scan.chatId !== id || !Array.isArray(scan.messages)) return [];
            return scan.messages
                .slice(start, start + count)
                .map((message: any) => win.WWebJS.getMessageModel(message));
            /* eslint-enable @typescript-eslint/no-explicit-any */
        },
        chatId,
        offset,
        limit,
    );
    return models.map((model) => new HistoryMessage(client, model));
}

export async function clearFullHistoryScan(client: WaClient, chatId: string): Promise<void> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return;
    await page.evaluate((id: string) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const root = globalThis as any;
        const win = root.window ?? root;
        if (win.__whatsappLoggerHistoryScan?.chatId === id) {
            delete win.__whatsappLoggerHistoryScan;
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
    }, chatId);
}

// ─────────────────────────────────────────────────────────────────────────
//  Gotowość strony
// ─────────────────────────────────────────────────────────────────────────

export interface StoreHealth {
    /** Czy window.Store w ogóle istnieje. */
    store: boolean;
    /** Czy wstrzyknięcie Store doszło do końca - bez tego nie ma WidFactory. */
    complete: boolean;
    /** Ile kontaktów WhatsApp zdążył wczytać. */
    contacts: number;
    /** Ile czatów widzi strona. */
    chats: number;
    /** Nazwy pól Store, których zabrakło. */
    missing: string[];
    /**
     * Dlaczego nie udało się zajrzeć do strony. Zaraz po sparowaniu WhatsApp
     * Web potrafi się przeładować i wtedy zapytanie ginie razem z kontekstem -
     * bez tego pola wyglądało to na "brak danych", choć wystarczyło poczekać.
     */
    error?: string | null;
}

/**
 * Pola Store, bez których rozpoznawanie nazw i numerów nie ma szans, wraz
 * z modułem WhatsApp Weba, z którego whatsapp-web.js je składa.
 *
 * Drugi adres nie jest ozdobnikiem. window.Store powstaje dopiero wtedy, gdy
 * biblioteka zdąży wykonać własne wstrzyknięcie, a strona potrafi się w tym
 * czasie przeładować i zabrać je ze sobą. Samo window.require działa wtedy
 * dalej, bo należy do WhatsApp Weba, nie do biblioteki. Bez tej drugiej drogi
 * start czekał pełne 90 sekund i szedł dalej z pustymi danymi, mimo że
 * kolekcje były na wyciągnięcie ręki.
 */
const REQUIRED_STORE_KEYS: ReadonlyArray<[key: string, moduleName: string]> = [
    ['WidFactory', 'WAWebWidFactory'],
    ['Contact', 'WAWebCollections'],
    ['Chat', 'WAWebCollections'],
    ['Msg', 'WAWebCollections'],
    ['LidUtils', 'WAWebApiContact'],
];

/** Sprawdza jednym zapytaniem, w jakim stanie jest strona WhatsApp Weba. */
export async function checkStore(client: WaClient): Promise<StoreHealth> {
    const page = client.pupPage;
    const empty: StoreHealth = {
        store: false,
        complete: false,
        contacts: 0,
        chats: 0,
        missing: REQUIRED_STORE_KEYS.map(([key]) => key),
    };
    if (!page || typeof page.evaluate !== 'function') return empty;

    try {
        return await page.evaluate((keys: ReadonlyArray<[string, string]>): StoreHealth => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const root = globalThis as any;
            const win = root.window ?? root;
            const store = win.Store;

            // Moduł z WhatsApp Weba jako druga droga do tej samej kolekcji.
            const modules = new Map<string, any>();
            const fromModule = (key: string, moduleName: string): any => {
                if (typeof win.require !== 'function') return undefined;
                if (!modules.has(moduleName)) {
                    try {
                        modules.set(moduleName, win.require(moduleName));
                    } catch {
                        modules.set(moduleName, undefined);
                    }
                }
                const loaded = modules.get(moduleName);
                return loaded?.[key] ?? loaded;
            };

            const found = new Map<string, any>();
            const missing: string[] = [];
            for (const [key, moduleName] of keys) {
                const value = store?.[key] ?? fromModule(key, moduleName);
                if (value) found.set(key, value);
                else missing.push(key);
            }

            const count = (collection: any): number => {
                try {
                    return collection?.getModelsArray?.().length ?? 0;
                } catch {
                    return 0;
                }
            };

            return {
                store: found.size > 0,
                complete: missing.length === 0,
                contacts: count(found.get('Contact')),
                chats: count(found.get('Chat')),
                missing,
            };
            /* eslint-enable @typescript-eslint/no-explicit-any */
        }, REQUIRED_STORE_KEYS);
    } catch (err) {
        // Nie połykamy tego po cichu: to jedyny ślad, gdy strona akurat
        // się przeładowuje albo puppeteer stracił z nią kontakt.
        return { ...empty, error: describeError(err) };
    }
}

export interface WaitOptions {
    /** Ile najdłużej czekamy na dane. */
    timeoutMs?: number;
    /** Co ile sprawdzamy. */
    pollMs?: number;
    /** Wywoływane przy każdym sprawdzeniu - do paska postępu. */
    onProgress?: (health: StoreHealth) => void;
}

/**
 * Czeka, aż WhatsApp Web wczyta książkę adresową. Bez tego pierwsze
 * wiadomości po starcie trafiają do folderów nazwanych cyframi z @lid,
 * bo o kontakt nie ma się jeszcze kogo zapytać.
 *
 * Zwraca stan, jaki udało się osiągnąć - także wtedy, gdy skończył się czas.
 * Program ma wtedy działać dalej, tylko z gorszym rozpoznawaniem nazw.
 */
export async function waitForContacts(
    client: WaClient,
    options: WaitOptions = {},
): Promise<StoreHealth> {
    const timeoutMs = options.timeoutMs ?? 90000;
    const pollMs = options.pollMs ?? 1000;
    const deadline = Date.now() + timeoutMs;

    let health = await checkStore(client);
    options.onProgress?.(health);

    while (Date.now() < deadline) {
        if (health.complete && health.contacts > 0) return health;

        await sleep(pollMs);
        health = await checkStore(client);
        options.onProgress?.(health);
    }

    // Poddajemy się po czasie, ale powód zostaje zapisany - inaczej jedyne,
    // co zostawało, to komunikat "brak danych" bez cienia wyjaśnienia.
    if (health.error) {
        log.quiet(new Error(health.error), { stage: 'czekanie na dane WhatsApp Weba' });
    }
    return health;
}

/** Zdanie o stanie strony, gotowe do wypisania przy starcie. */
export function healthLine(health: StoreHealth): string {
    if (!health.store) {
        // Świadomie bez wyroku na przyszłość: program i tak dociąga nazwy przy
        // każdej wiadomości i przenosi foldery, gdy pozna lepszą. Poprzednia
        // wersja tego komunikatu straszyła "nazwy będą samymi cyframi",
        // a czaty nazywały się poprawnie.
        const why = health.error ? ` (${health.error})` : '';
        return (
            `• Nie zajrzałem do danych WhatsApp Weba${why}. ` +
            'Archiwizacja działa, nazwy czatów mogą dojść z opóźnieniem.'
        );
    }
    if (!health.complete) {
        return (
            `✗ WhatsApp Web udostępnił dane tylko częściowo (brakuje: ${health.missing.join(', ')}). ` +
            'Najczęściej znaczy to, że whatsapp-web.js jest starszy niż bieżąca wersja WhatsApp Weba - ' +
            'pomaga "npm update whatsapp-web.js".'
        );
    }
    if (health.contacts === 0) {
        return '• Książka adresowa jest jeszcze pusta - nazwy czatów dojdą, gdy WhatsApp ją prześle.';
    }
    return `✓ Dane wczytane: ${health.contacts} kontaktów, ${health.chats} czatów.`;
}
