// Dostęp do wnętrza WhatsApp Weba, który przeżywa przeładowanie strony.
//
// whatsapp-web.js składa window.Store i window.WWebJS raz, przy wstrzyknięciu.
// Gdy strona WhatsApp Weba się przeładuje - a robi to sama, przy aktualizacji
// i po chwilowej utracie łącza - oba obiekty znikają razem z dokumentem.
// Biblioteka odtwarza je dopiero we własnej obsłudze "framenavigated", a to
// bywa kilkanaście sekund później.
//
// W tej dziurze każdy nasz odczyt ze strony kończył się porażką bez wyjaśnienia
// i po niej właśnie poznać trzy usterki zgłoszone z produkcji: pliki nie
// schodziły ("przeglądarka nie ma jeszcze Store WhatsAppa"), zdjęcia profilowe
// po cichu zwracały null, a przegląd relacji uznawał, że relacji nie ma.
//
// Sam WhatsApp Web przeładowania nie traci: window.require należy do niego,
// nie do biblioteki, i działa od pierwszej chwili nowego dokumentu. Ten moduł
// zakłada w stronie własnego pomocnika, który składa brakujące kolekcje wprost
// z modułów WhatsAppa.
//
// Pomocnik siedzi pod własną nazwą i to nie jest ostrożność na wyrost.
// Gdybyśmy odtworzyli samo window.Store, biblioteka przy najbliższym
// "framenavigated" uznałaby wstrzyknięcie za zrobione - sprawdza dokładnie
// obecność window.Store i window.WWebJS - i nie podpięłaby z powrotem nasłuchu
// na nowe wiadomości. Naprawa mediów uciszyłaby wtedy całe archiwum na żywo.

import { log } from './log';
import type { WaClient } from './types';
import { sleep } from './util';

/** Nazwa pomocnika w oknie strony. Celowo nie "Store" - patrz nagłówek. */
export const PAGE_HELPER = '__whatsappLoggerPage';

/** Skąd pochodzi wnętrze WhatsApp Weba, którym się posługujemy. */
export type PageAccessSource = 'store' | 'require' | 'brak';

export interface PageAccess {
    /** Czy da się cokolwiek sensownego odczytać ze strony. */
    ready: boolean;
    source: PageAccessSource;
    /** Kolekcje, których nie udało się zdobyć żadną drogą. */
    missing: string[];
}

const UNAVAILABLE: PageAccess = { ready: false, source: 'brak', missing: [] };

/**
 * Ile razy pytamy stronę, zanim uznamy ją za niedostępną, i ile czekamy między
 * pytaniami.
 *
 * Przeładowanie trwa ułamek sekundy, a w jego trakcie ginie cały kontekst
 * wykonania - page.evaluate() rzuca wtedy wyjątkiem. Krótka pauza zamienia
 * tę chwilę w zwykłe opóźnienie zamiast w straconą wiadomość.
 */
const TRIES = 3;
const WAIT_MS = 500;

export interface PageAccessOptions {
    /**
     * Czy poczekać na wracającą stronę.
     *
     * Domyślnie nie: przy zdjęciach profilowych i nazwach czatów nieudany
     * odczyt kosztuje tyle, co nic - wrócimy do niego przy następnym przeglądzie
     * i nie ma powodu, żeby jeden przegląd przespał pięćdziesiąt sekund.
     * Czekamy tam, gdzie porażka boli: przy pliku z wiadomości, bo ten trzeba
     * potem odzyskiwać z kolejki ponowień.
     */
    waitForPage?: boolean;
}

/**
 * Upewnia się, że w stronie siedzi nasz pomocnik, i mówi, w jakim jest stanie.
 *
 * Wołać przed każdym page.evaluate(), które sięga do wnętrza WhatsAppa -
 * to jedno tanie zapytanie, gdy pomocnik już tam jest.
 */
export async function ensurePageAccess(
    client: WaClient | null | undefined,
    options: PageAccessOptions = {},
): Promise<PageAccess> {
    const page = client?.pupPage;
    if (!page || typeof page.evaluate !== 'function') return UNAVAILABLE;

    const tries = options.waitForPage ? TRIES : 1;
    let last: PageAccess = UNAVAILABLE;

    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            let state = await page.evaluate(describeAccess, PAGE_HELPER);
            if (!state.ready) {
                await page.evaluate(installHelper, PAGE_HELPER);
                state = await page.evaluate(describeAccess, PAGE_HELPER);
            }
            if (state.ready) return state;
            last = state;
        } catch (err) {
            // Strona akurat się przeładowuje: kontekst wykonania ginie razem
            // z dokumentem. To nie jest awaria do zgłaszania na ekran, tylko
            // powód, żeby spróbować za chwilę jeszcze raz.
            log.quiet(err, { stage: 'dostęp do wnętrza WhatsApp Weba' });
            last = UNAVAILABLE;
        }

        if (attempt < tries) await sleep(WAIT_MS);
    }

    return last;
}

/** Jednym zdaniem, po polsku - do komunikatów diagnostycznych. */
export function pageAccessLine(access: PageAccess): string {
    if (access.source === 'store') return 'window.Store jest na miejscu';
    if (access.source === 'require') {
        return 'window.Store zniknął po przeładowaniu strony - kolekcje odtworzone z window.require';
    }
    const missing = access.missing.length > 0 ? ` (brakuje: ${access.missing.join(', ')})` : '';
    return `wnętrze WhatsApp Weba niedostępne${missing}`;
}

// ─────────────────────────────────────────────────────────────────────────
//  Kod wykonywany w stronie
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stan pomocnika. Osobne, tanie zapytanie - żeby nie wstrzykiwać go od nowa
 * przy każdym odczycie, gdy wszystko jest w porządku.
 */
function describeAccess(helperName: string): PageAccess {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const helper = (globalThis as any)[helperName];
    if (!helper || typeof helper.describe !== 'function') {
        return { ready: false, source: 'brak', missing: [] };
    }
    try {
        return helper.describe();
    } catch {
        return { ready: false, source: 'brak', missing: [] };
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Zakłada pomocnika w oknie strony. Musi być samodzielny - nie widzi niczego
 * z modułów Node, bo puppeteer przenosi go tam jako sam tekst funkcji.
 */
function installHelper(helperName: string): void {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const win = globalThis as any;
    if (win[helperName]?.wersja === 1) return;

    // Kolekcja w Store → moduł WhatsApp Weba i pole w nim (null = cały moduł).
    // Te same adresy, których używa wstrzyknięcie whatsapp-web.js; różnica
    // polega tylko na tym, że sięgamy po nie wtedy, gdy są potrzebne, a nie
    // raz na starcie.
    const SOURCES: Array<[string, string, string | null]> = [
        ['Msg', 'WAWebCollections', 'Msg'],
        ['Chat', 'WAWebCollections', 'Chat'],
        ['Contact', 'WAWebCollections', 'Contact'],
        ['Status', 'WAWebCollections', 'Status'],
        ['GroupMetadata', 'WAWebCollections', 'GroupMetadata'],
        ['ProfilePicThumb', 'WAWebCollections', 'ProfilePicThumb'],
        ['ConversationMsgs', 'WAWebChatLoadMessages', null],
        ['DownloadManager', 'WAWebDownloadManager', 'downloadManager'],
        ['WidFactory', 'WAWebWidFactory', null],
        ['ProfilePic', 'WAWebContactProfilePicThumbBridge', null],
        ['MsgKey', 'WAWebMsgKey', null],
    ];

    // Kolekcja wiadomości jako dowód, że wnętrze WhatsAppa w ogóle odpowiada.
    // Celowo jedna, nie komplet: każde wywołanie i tak sprawdza to, czego samo
    // potrzebuje (zdjęcia - ProfilePicThumb, pliki - DownloadManager), a jeden
    // brakujący moduł nie może oznaczać, że nie da się zrobić nic.
    const CORE = ['Msg'];

    const safe = (read: () => any, fallback: any): any => {
        try {
            return read();
        } catch {
            return fallback;
        }
    };

    // Rejestr modułów WhatsAppa sam w sobie jest pamięcią podręczną, ale
    // window.require dla nieznanej nazwy rzuca - stąd zapamiętujemy również
    // nieudane próby, żeby nie powtarzać ich przy każdym pliku.
    const modules = new Map<string, any>();
    const load = (name: string): any => {
        if (!modules.has(name)) {
            modules.set(
                name,
                safe(
                    () => (typeof win.require === 'function' ? win.require(name) : undefined),
                    undefined,
                ),
            );
        }
        return modules.get(name);
    };

    /**
     * Store złożony z tego, co akurat jest pod ręką: najpierw obiekt
     * biblioteki, a na brakujące kolekcje - moduły WhatsApp Weba.
     */
    const store = (): any => {
        const merged: any = {};

        const direct = safe(() => win.Store, null);
        if (direct && typeof direct === 'object') {
            safe(() => Object.assign(merged, direct), null);
        }

        for (const [key, moduleName, field] of SOURCES) {
            if (merged[key]) continue;
            const loaded = load(moduleName);
            const value = field === null ? loaded : safe(() => loaded?.[field], undefined);
            if (value) merged[key] = value;
        }

        return merged;
    };

    const describe = (): { ready: boolean; source: string; missing: string[] } => {
        const direct = safe(() => win.Store, null);
        const merged = store();
        const ready = CORE.every((key) => Boolean(merged[key]));
        const fromStore = CORE.every((key) => Boolean(safe(() => direct?.[key], null)));

        return {
            ready,
            source: !ready ? 'brak' : fromStore ? 'store' : 'require',
            missing: SOURCES.filter(([key]) => !merged[key]).map(([key]) => key),
        };
    };

    /**
     * Model wiadomości w postaci, którą rozumie whatsapp-web.js po stronie Node.
     *
     * Zwykle robi to WWebJS.getMessageModel, ale ten znika razem ze Store.
     * Droga awaryjna robi to samo co on, tylko bez ozdobników (podświetlone
     * odnośniki, przyciski) - dla archiwum liczy się treść, nadawca i plik.
     */
    const messageModel = (message: any): any => {
        const viaLibrary = safe(() => win.WWebJS?.getMessageModel, null);
        if (typeof viaLibrary === 'function') {
            const model = safe(() => viaLibrary(message), null);
            if (model) return model;
        }

        const model = safe(() => message?.serialize?.(), null);
        if (!model) return null;

        // Ten jeden szczegół musi się zgadzać: przy relacjach i grupach
        // id.remote bywa obiektem Wid, a strona Node oczekuje tam napisu.
        safe(() => {
            if (model.id && typeof model.id.remote === 'object') {
                model.id = Object.assign({}, model.id, {
                    remote: model.id.remote?._serialized ?? String(model.id.remote),
                });
            }
        }, null);

        return model;
    };

    /** Bajty z serwera mediów na base64 - również bez WWebJS. */
    const toBase64 = (buffer: any): Promise<string | null> => {
        const viaLibrary = safe(() => win.WWebJS?.arrayBufferToBase64Async, null);
        if (typeof viaLibrary === 'function') {
            const started = safe(() => viaLibrary(buffer), null);
            if (started) return Promise.resolve(started).catch(() => null);
        }

        return new Promise<string | null>((resolve) => {
            try {
                const blob = new win.Blob([buffer], { type: 'application/octet-stream' });
                const reader = new win.FileReader();
                reader.onloadend = (): void => {
                    const value = reader.result;
                    resolve(typeof value === 'string' ? (value.split(',')[1] ?? null) : null);
                };
                reader.onerror = (): void => resolve(null);
                reader.readAsDataURL(blob);
            } catch {
                resolve(null);
            }
        });
    };

    win[helperName] = { wersja: 1, store, describe, messageModel, toBase64 };
    /* eslint-enable @typescript-eslint/no-explicit-any */
}
