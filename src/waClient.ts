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

// ─────────────────────────────────────────────────────────────────────────
//  Odczyt prosto ze Store, bez serializacji całych modeli
// ─────────────────────────────────────────────────────────────────────────
//
// getChats(), getChatById() i getBroadcasts() z whatsapp-web.js przepuszczają
// modele przez getChatModel()/serialize(). Wystarczy jeden wadliwy model -
// najczęściej grupa, której nie da się dociągnąć metadanych - i całe
// wywołanie kończy się zminifikowanym "r: r". Odrzucało to listę czatów
// razem z nadrabianiem, więc po każdym offline zostawała dziura.
//
// Poniższe funkcje czytają dokładnie te same kolekcje, ale biorą z nich tylko
// identyfikatory i wiadomości. Zwracają null, gdy strona jest niedostępna albo
// oddała coś nieoczekiwanego - wtedy wywołujący wraca do publicznego API.

/** Czat widziany przez stronę: tylko to, czego potrzebuje nadrabianie. */
export interface RawChatSummary {
    id: string;
    name: string;
    /**
     * Znacznik ostatniej aktywności w sekundach, prosto z modelu WhatsAppa.
     * Po nim poznajemy rozmowę, w której coś się działo, gdy program nie
     * pracował - także taką, która nie ma jeszcze folderu w archiwum.
     */
    lastActivity: number;
    /** Ile wiadomości WhatsApp uważa za nieprzeczytane. */
    unread: number;
}

/** Lista czatów bez getChatModel(). */
export async function listChatsRaw(client: WaClient): Promise<RawChatSummary[] | null> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return null;

    try {
        const chats = await page.evaluate((): unknown => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const root = globalThis as any;
            const win = root.window ?? root;
            let collection = win.Store?.Chat;
            if (!collection?.getModelsArray && typeof win.require === 'function') {
                try {
                    collection = win.require('WAWebCollections')?.Chat;
                } catch {
                    collection = undefined;
                }
            }
            if (!collection?.getModelsArray) return null;

            return collection.getModelsArray().map((chat: any) => {
                const id = chat?.id?._serialized;
                if (typeof id !== 'string' || id.length === 0) return null;
                // "t" bywa jedynym śladem po rozmowie, której nie ma jeszcze
                // w archiwum - dlatego czytamy go osobno od nazwy, która
                // potrafi rzucić wyjątkiem.
                let lastActivity = 0;
                let unread = 0;
                try {
                    lastActivity = Number(chat?.t ?? chat?.lastReceivedKey?.t ?? 0) || 0;
                    unread = Number(chat?.unreadCount ?? 0) || 0;
                } catch {
                    lastActivity = 0;
                }

                try {
                    // formattedTitle bywa getterem liczonym z kontaktu - gdyby
                    // rzucił, czat i tak ma zostać na liście, tylko bez nazwy.
                    const name = chat.formattedTitle ?? chat.name ?? chat.contact?.name ?? '';
                    return { id, name: typeof name === 'string' ? name : '', lastActivity, unread };
                } catch {
                    return { id, name: '', lastActivity, unread };
                }
            });
            /* eslint-enable @typescript-eslint/no-explicit-any */
        });
        return chatSummaries(chats);
    } catch (err) {
        log.quiet(err, { stage: 'surowa lista czatów' });
        return null;
    }
}

/**
 * Wszystkie konta WhatsAppa z książki adresowej tej sesji. Świeża instalacja
 * nie ma jeszcze żadnego czatu w Store, więc bez tego pełne nadrabianie nie
 * miałoby skąd wziąć rozmów z osobami, do których dawno nikt nie pisał.
 */
export async function listContactChatIds(client: WaClient): Promise<string[] | null> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return null;

    try {
        const ids = await page.evaluate((): unknown => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const root = globalThis as any;
            const win = root.window ?? root;
            let collection = win.Store?.Contact;
            if (!collection?.getModelsArray && typeof win.require === 'function') {
                try {
                    collection = win.require('WAWebCollections')?.Contact;
                } catch {
                    collection = undefined;
                }
            }
            if (!collection?.getModelsArray) return null;

            return collection.getModelsArray().map((contact: any) => {
                try {
                    // Dla kontaktu @lid numer telefonu jest lepszym kluczem -
                    // WhatsApp oddaje dla niego komplet danych częściej.
                    const id = contact?.phoneNumber?._serialized ?? contact?.id?._serialized;
                    return typeof id === 'string' ? id : null;
                } catch {
                    return null;
                }
            });
            /* eslint-enable @typescript-eslint/no-explicit-any */
        });
        return contactIds(ids);
    } catch (err) {
        log.quiet(err, { stage: 'surowa lista kontaktów' });
        return null;
    }
}

/**
 * Odpowiednik Chat.fetchMessages(), ale bez obiektu Chat - a więc i bez
 * serializacji, która wywraca całe nadrabianie. Kroki są dokładnie te same,
 * których używa whatsapp-web.js 1.34.6.
 */
export async function fetchMessagesRaw(
    client: WaClient,
    chatId: string,
    limit: number,
): Promise<WaMessage[] | null> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return null;
    if (!Number.isFinite(limit) || limit <= 0) return null;

    let models: unknown;
    try {
        models = await page.evaluate(
            async (id: string, count: number): Promise<unknown> => {
                /* eslint-disable @typescript-eslint/no-explicit-any */
                const root = globalThis as any;
                const win = root.window ?? root;
                if (!win.WWebJS?.getChat || !win.WWebJS?.getMessageModel) return null;
                if (!win.Store?.ConversationMsgs?.loadEarlierMsgs) return null;

                const chat = await win.WWebJS.getChat(id, { getAsModel: false });
                if (!chat?.msgs?.getModelsArray) return null;

                const keep = (message: any): boolean => !message?.isNotification;
                let msgs = chat.msgs.getModelsArray().filter(keep);
                while (msgs.length < count) {
                    const loaded = await win.Store.ConversationMsgs.loadEarlierMsgs(
                        chat,
                        chat.msgs,
                    );
                    if (!loaded?.length) break;
                    msgs = [...loaded.filter(keep), ...msgs];
                }

                msgs.sort((a: any, b: any) => Number(a?.t ?? 0) - Number(b?.t ?? 0));
                if (msgs.length > count) msgs = msgs.slice(msgs.length - count);
                return msgs.map((message: any) => win.WWebJS.getMessageModel(message));
                /* eslint-enable @typescript-eslint/no-explicit-any */
            },
            chatId,
            Math.floor(limit),
        );
    } catch (err) {
        log.quiet(err, { stage: 'surowy odczyt wiadomości', chat: chatId });
        return null;
    }

    return toMessages(client, models);
}

/**
 * Ostatnia deska ratunku: wiadomości czatu prosto z kolekcji Store.Msg.
 *
 * fetchMessagesRaw() potrzebuje WWebJS.getChat(), a ten dla czatu spoza
 * pamięci schodzi do Store.FindOrCreateChat - modułu, którego kolejne wydania
 * WhatsApp Weba potrafią nie mieć pod tą nazwą. Padało wtedy i to wywołanie,
 * i publiczne getChatById(), a czat wypadał z nadrabiania w całości ("błędów
 * czatów N", zero przejrzanych wiadomości).
 *
 * Tutaj nie ma żadnego modelu czatu ani ładowania historii - bierzemy to, co
 * przeglądarka i tak trzyma w pamięci. To mniej niż pełne okno nadrabiania,
 * ale znacznie więcej niż nic.
 */
export async function readChatMessagesFromStore(
    client: WaClient,
    chatId: string,
    limit: number,
): Promise<WaMessage[] | null> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return null;

    const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50_000;

    let models: unknown;
    try {
        models = await page.evaluate(
            (id: string, wanted: number): unknown => {
                /* eslint-disable @typescript-eslint/no-explicit-any */
                const root = globalThis as any;
                const win = root.window ?? root;
                if (!win.WWebJS?.getMessageModel) return null;

                let collection = win.Store?.Msg;
                if (!collection?.getModelsArray && typeof win.require === 'function') {
                    try {
                        collection = win.require('WAWebCollections')?.Msg;
                    } catch {
                        collection = undefined;
                    }
                }
                if (!collection?.getModelsArray) return null;

                const belongsHere = (message: any): boolean => {
                    try {
                        const remote = message?.id?.remote;
                        const serialized =
                            typeof remote === 'string' ? remote : remote?._serialized;
                        return serialized === id;
                    } catch {
                        return false;
                    }
                };

                let msgs = collection
                    .getModelsArray()
                    .filter((message: any) => !message?.isNotification && belongsHere(message));

                msgs.sort((a: any, b: any) => Number(a?.t ?? 0) - Number(b?.t ?? 0));
                if (msgs.length > wanted) msgs = msgs.slice(msgs.length - wanted);
                return msgs.map((message: any) => win.WWebJS.getMessageModel(message));
                /* eslint-enable @typescript-eslint/no-explicit-any */
            },
            chatId,
            count,
        );
    } catch (err) {
        log.quiet(err, { stage: 'odczyt wiadomości z kolekcji', chat: chatId });
        return null;
    }

    const messages = toMessages(client, models);
    // Pusto znaczy tu "nic nie wiem", a nie "czat jest pusty" - wywołujący
    // ma jeszcze publiczne API do wypróbowania.
    return messages && messages.length > 0 ? messages : null;
}

/**
 * Relacje prosto z kolekcji Store.Status. getBroadcasts() składa je z
 * status.serialize(), a to w nowszych wydaniach WhatsApp Weba potrafi oddać
 * model bez pola msgs - przegląd nie miał wtedy czego dopisywać.
 */
export async function listStatusMessages(client: WaClient): Promise<WaMessage[] | null> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return null;

    let models: unknown;
    try {
        models = await page.evaluate((): unknown => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const root = globalThis as any;
            const win = root.window ?? root;
            if (!win.WWebJS?.getMessageModel) return null;

            let collection = win.Store?.Status;
            if (!collection?.getModelsArray && typeof win.require === 'function') {
                try {
                    collection = win.require('WAWebCollections')?.Status;
                } catch {
                    collection = undefined;
                }
            }
            if (!collection?.getModelsArray) return null;

            const result: unknown[] = [];
            for (const status of collection.getModelsArray()) {
                try {
                    const msgs = status?.msgs?.getModelsArray?.() ?? [];
                    for (const message of msgs) {
                        if (!message || message.isNotification) continue;
                        result.push(win.WWebJS.getMessageModel(message));
                    }
                } catch {
                    // Jedna wadliwa relacja nie może zabrać pozostałych.
                }
            }
            return result;
            /* eslint-enable @typescript-eslint/no-explicit-any */
        });
    } catch (err) {
        log.quiet(err, { stage: 'surowy odczyt relacji' });
        return null;
    }

    return toMessages(client, models);
}

// ─────────────────────────────────────────────────────────────────────────
//  Nazwa czatu i zdjęcie profilowe bez serializacji modelu
// ─────────────────────────────────────────────────────────────────────────

/**
 * Nazwa czatu prosto z kolekcji Store.
 *
 * message.getChat() przepuszcza rozmowę przez getChatModel(), a ten dla grupy
 * bez dociągniętych metadanych kończy się zminifikowanym "r: r". Nazwa
 * przepadała wtedy w całości i w archiwum zostawał sam identyfikator grupy.
 * Tutaj bierzemy wyłącznie tytuł: z modelu czatu, z metadanych grupy, a poza
 * grupami z kontaktu - żadnej serializacji, więc nie ma się na czym wywrócić.
 * Zwracana nazwa jest zawsze tą "porządną" (temat grupy albo wpis z książki
 * adresowej), nigdy sformatowanym numerem telefonu - dzwoniący traktuje ją
 * jako NameTier.SAVED.
 */
export async function readChatSubject(client: WaClient, chatId: string): Promise<string | null> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return null;

    let name: unknown;
    try {
        name = await page.evaluate((id: string): string | null => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const root = globalThis as any;
            const win = root.window ?? root;
            const store = win.Store;
            if (!store) return null;

            const text = (value: unknown): string | null => {
                const clean = typeof value === 'string' ? value.trim() : '';
                return clean.length > 0 ? clean : null;
            };

            let wid: any = null;
            try {
                wid = store.WidFactory?.createWid?.(id) ?? null;
            } catch {
                wid = null;
            }

            // Sam get(), bez findOrCreate - inaczej pytanie o nazwę zakładałoby
            // przy okazji pusty czat, którego WhatsApp wcześniej nie miał.
            const pick = (collection: any): any => {
                for (const key of [wid, id]) {
                    if (!key) continue;
                    try {
                        const found = collection?.get?.(key);
                        if (found) return found;
                    } catch {
                        /* następna postać identyfikatora */
                    }
                }
                return null;
            };

            const isGroup = id.endsWith('@g.us');

            // formattedTitle grupy to jej temat, ale dla rozmowy z jedną
            // osobą jest to sformatowany numer ("+48 880 969 041"). Taka
            // nazwa udawałaby wpis z książki adresowej, więc poza grupami
            // jej nie tykamy.
            const chat = pick(store.Chat);
            for (const key of isGroup ? ['formattedTitle', 'subject', 'name'] : ['name']) {
                try {
                    // Te pola bywają getterami liczonymi z kontaktu i potrafią
                    // rzucić - wtedy próbujemy po prostu następnego.
                    const found = text(chat?.[key]);
                    if (found) return found;
                } catch {
                    /* następne pole */
                }
            }

            // Grupa: temat leży w metadanych nawet wtedy, gdy model czatu go
            // jeszcze nie zna. To jest ta ścieżka, której brakowało.
            if (isGroup) {
                try {
                    const subject = text(pick(store.GroupMetadata)?.subject);
                    if (subject) return subject;
                } catch {
                    /* brak metadanych to nie awaria */
                }
                return null;
            }

            // Wyłącznie nazwy, które faktycznie ktoś nadał: zapisana
            // w książce adresowej i zweryfikowana nazwa firmowa. Reszta pól
            // kontaktu spada na numer telefonu.
            const contact = pick(store.Contact);
            for (const key of ['name', 'verifiedName']) {
                try {
                    const found = text(contact?.[key]);
                    if (found) return found;
                } catch {
                    /* następne pole */
                }
            }

            return null;
            /* eslint-enable @typescript-eslint/no-explicit-any */
        }, chatId);
    } catch (err) {
        log.quiet(err, { stage: 'nazwa czatu ze Store', chat: chatId });
        return null;
    }

    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
}

/**
 * Adres zdjęcia profilowego bez Client.getProfilePicUrl().
 *
 * Publiczne wywołanie schodzi do requestProfilePicFromServer(), a ten
 * w bieżącym wydaniu WhatsApp Weba wywraca się na "Cannot read properties of
 * undefined (reading 'isNewsletter')" - i to dla każdego kontaktu po kolei,
 * więc w archiwum nie było ani jednego zdjęcia. Miniatura leży już w kolekcji
 * ProfilePicThumb; pytanie serwera zostaje planem awaryjnym, ale jego awaria
 * nie zabiera już całego pobierania.
 */
export async function readProfilePicUrl(client: WaClient, chatId: string): Promise<string | null> {
    const page = client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return null;

    let url: unknown;
    try {
        url = await page.evaluate(async (id: string): Promise<string | null> => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const root = globalThis as any;
            const win = root.window ?? root;
            const store = win.Store;
            if (!store) return null;

            const address = (thumb: any): string | null => {
                for (const key of ['eurl', 'imgFull', 'img']) {
                    const value = thumb?.[key];
                    if (typeof value === 'string' && value.startsWith('http')) return value;
                }
                return null;
            };

            let wid: any = null;
            try {
                wid = store.WidFactory?.createWid?.(id) ?? null;
            } catch {
                wid = null;
            }

            // 1. To, co przeglądarka już ma - bez jednego zapytania do sieci.
            for (const key of [wid, id]) {
                if (!key) continue;
                try {
                    const found = address(store.ProfilePicThumb?.get?.(key));
                    if (found) return found;
                } catch {
                    /* następna postać identyfikatora */
                }
            }

            // 2. Kolekcja potrafi sama dociągnąć miniaturę z serwera.
            for (const key of [wid, id]) {
                if (!key) continue;
                try {
                    const found = address(await store.ProfilePicThumb?.find?.(key));
                    if (found) return found;
                } catch {
                    /* następna postać identyfikatora */
                }
            }

            // 3. Droga biblioteki. Bywa, że tylko ona zna świeże zdjęcie,
            // ale jej wyjątek nie może już przewrócić całego pobierania.
            if (wid) {
                for (const ask of [
                    store.ProfilePic?.requestProfilePicFromServer,
                    store.ProfilePic?.profilePicFind,
                ]) {
                    if (typeof ask !== 'function') continue;
                    try {
                        const found = address(await ask.call(store.ProfilePic, wid));
                        if (found) return found;
                    } catch {
                        /* następna droga */
                    }
                }
            }

            return null;
            /* eslint-enable @typescript-eslint/no-explicit-any */
        }, chatId);
    } catch (err) {
        log.quiet(err, { stage: 'zdjęcie profilowe ze Store', chat: chatId });
        return null;
    }

    return typeof url === 'string' && url.length > 0 ? url : null;
}

function chatSummaries(value: unknown): RawChatSummary[] | null {
    if (!Array.isArray(value)) return null;

    const seen = new Set<string>();
    const result: RawChatSummary[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const { id, name, lastActivity, unread } = item as {
            id?: unknown;
            name?: unknown;
            lastActivity?: unknown;
            unread?: unknown;
        };
        if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        result.push({
            id,
            name: typeof name === 'string' ? name : '',
            lastActivity: typeof lastActivity === 'number' && Number.isFinite(lastActivity) ? lastActivity : 0,
            unread: typeof unread === 'number' && Number.isFinite(unread) ? unread : 0,
        });
    }
    // Pusta lista to nie jest odpowiedź, na której da się polegać - lepiej
    // spróbować publicznego API niż uznać, że nie ma żadnych czatów.
    return result.length > 0 ? result : null;
}

function contactIds(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;

    const result = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'string') continue;
        if (!/@(c\.us|lid)$/.test(item)) continue;
        result.add(item);
    }
    return result.size > 0 ? [...result] : null;
}

/** Modele ze strony na obiekty Message tej samej klasy, co reszta programu. */
function toMessages(client: WaClient, models: unknown): WaMessage[] | null {
    if (!Array.isArray(models)) return null;
    return models
        .filter((model): model is object => Boolean(model) && typeof model === 'object')
        .map((model) => new HistoryMessage(client, model));
}
