// Pobieranie plików dołączonych do wiadomości.
//
// Plik, którego nie da się zapisać (za duży, wyłączony typ, błąd pobierania),
// nie znika bez śladu - w archiwum zostaje po nim notatka z typem, nazwą
// i rozmiarem, żeby było wiadomo, że coś tam było.

import path from 'node:path';
import fs from 'node:fs/promises';
import type { Config } from './config';
import { messageHash, messageKey } from './identity';
import { log } from './log';
import type { DownloadedMedia, SkippedMedia, WaMessage } from './types';
import { ensureDir, sleep } from './util';

/**
 * Odstępy przed kolejnymi podejściami do jednego pliku.
 *
 * WhatsApp Web zwraca pusty wynik również wtedy, gdy pobieranie dopiero
 * ruszyło (mediaStage "FETCHING") - biblioteka nie czeka na jego koniec.
 * Jedno podejście gubiło z tego powodu zdjęcia i relacje, które chwilę
 * później były już gotowe.
 */
const RETRY_WAITS_MS = [0, 1200, 3000] as const;

/**
 * Ile plików w jednym czacie wolno ponawiać w czasie jednego okna czasowego.
 * Stara historia bywa nie do odzyskania i nie ma sensu dokładać do niej
 * kilku sekund na każdą wiadomość.
 */
const RETRIED_FAILURES_PER_CHAT = 5;

/**
 * Po tylu minutach czat zaczyna liczyć się od nowa.
 *
 * Wcześniej licznik nieudanych ponowień i lista czatów "już zgłoszonych"
 * rosły przez całe życie procesu. Po piątym straconym pliku czat dostawał
 * do końca sesji jedno podejście zamiast trzech, a jego błędy przestawały
 * trafiać do dziennika - awaria sprzed tygodnia uciszała diagnostykę na
 * zawsze. Okno czasowe zostawia ochronę przed zalewem, ale pozwala wrócić
 * do pełnej obsługi, gdy WhatsApp znów zaczyna oddawać pliki.
 */
const CHAT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Ile czekamy w przeglądarce, aż WhatsApp Web skończy ściągać plik.
 *
 * downloadMedia() z biblioteki tylko rozpoczyna pobieranie i natychmiast
 * oddaje pustkę, gdy mediaStage to "FETCHING". Przy zdjęciu na kilkaset kB
 * i wolniejszym łączu nie mieściło się to w przerwach między podejściami -
 * i tak powstawały notatki "nie udało się pobrać pliku". Czekamy więc na
 * miejscu, na konkretny etap, zamiast zgadywać w Node.
 *
 * Na żywo czekamy krótko: każda sekunda tutaj wstrzymuje kolejkę czatu,
 * a plik, który się nie udał, ma jeszcze kolejkę ponowień. Cierpliwość
 * należy do przeglądu zaległości - patrz MEDIA_RETRY_STAGE_WAIT_MS.
 */
const STAGE_WAIT_MS = 8_000;

export interface MediaTarget {
    /** Folder, do którego trafiają pliki tego czatu. */
    mediaDir: string;
    /** Folder czatu - ścieżki w HTML są liczone względem niego. */
    chatDir: string;
    /** Relacje wymagają innej drogi pobierania niż zwykłe wiadomości. */
    isStatus: boolean;
    /** Nazwa czatu do komunikatów. */
    label: string;
}

export interface DownloadOptions {
    /**
     * Ile najdłużej czekać w przeglądarce na zakończenie pobierania.
     *
     * Przy zapisie na bieżąco czekamy krótko: kolejka czatu stoi, a plik
     * ma jeszcze kolejkę ponowień. Przy przeglądzie zaległości odwrotnie -
     * to jest właśnie ta chwila, w której warto poczekać, aż telefon
     * skończy wysyłać wygasłe media, bo nikt na ten przegląd nie czeka.
     */
    waitForStageMs?: number;
}

export interface MediaResult {
    /** Ścieżka do pliku względem folderu czatu albo null. */
    path: string | null;
    /** Oryginalna nazwa pliku, jeśli WhatsApp ją podał. */
    name: string | null;
    skipped: SkippedMedia | null;
}

/**
 * Wynik pobrania wprost ze Store razem z powodem niepowodzenia.
 *
 * Samo `null` nie wystarczało: "nie udało się pobrać pliku" znaczyło
 * jednocześnie wygasłe media, wiadomość poza pamięcią przeglądarki, błąd
 * deszyfrowania i odmowę serwera. Bez rozróżnienia nie dało się orzec,
 * czy winne jest łącze serwera, czy WhatsApp, więc powód wędruje aż do
 * notatki w archiwum.
 */
export interface StoreDownload {
    media: DownloadedMedia | null;
    /** mediaStage z przeglądarki, gdy dało się go odczytać. */
    stage: string | null;
    /** Krótkie "dlaczego nie" po polsku. Null, gdy plik jest. */
    why: string | null;
}

/** To, co MediaDownloader.fetch() wie po wszystkich podejściach. */
interface FetchOutcome {
    media: DownloadedMedia | null;
    why: string | null;
}

/** Ile razy czat zawiódł i od kiedy liczymy to okno. */
interface ChatWindow {
    failures: number;
    reportedReason: string | null;
    since: number;
}

const NOTHING: MediaResult = { path: null, name: null, skipped: null };

export class MediaDownloader {
    /** Stan czatu w bieżącym oknie czasowym - licznik i ostatni komunikat. */
    private readonly windows = new Map<string, ChatWindow>();

    constructor(private readonly config: Config) {}

    /** Okno czatu, odświeżone gdy poprzednie się zestarzało. */
    private windowFor(target: MediaTarget): ChatWindow {
        const now = Date.now();
        const current = this.windows.get(target.label);
        if (current && now - current.since < CHAT_WINDOW_MS) return current;

        const fresh: ChatWindow = { failures: 0, reportedReason: null, since: now };
        this.windows.set(target.label, fresh);
        return fresh;
    }

    private retriesLeft(target: MediaTarget): number {
        return RETRIED_FAILURES_PER_CHAT - this.windowFor(target).failures;
    }

    private countRetriedFailure(target: MediaTarget): void {
        this.windowFor(target).failures++;
    }

    /**
     * Pobiera i zapisuje plik z wiadomości. Zawsze zwraca wynik - błąd
     * pobierania kończy się notatką w archiwum, a nie wyjątkiem.
     */
    async download(
        message: WaMessage,
        target: MediaTarget,
        options: DownloadOptions = {},
    ): Promise<MediaResult> {
        if (!message.hasMedia) return NOTHING;

        const meta: SkippedMedia = {
            reason: '',
            type: message.type,
            filename: message._data?.filename ?? null,
            bytes: message._data?.size ?? null,
        };

        if (!this.config.mediaTypes.has(message.type)) {
            return { path: null, name: null, skipped: { ...meta, reason: 'typ wyłączony w konfiguracji' } };
        }

        // whatsapp-web.js często zna rozmiar jeszcze przed pobraniem. Korzystamy
        // z niego, żeby duży plik nie zdążył wejść do Chromium i Node jako
        // base64. Gdy WhatsApp nie poda rozmiaru, zachowujemy dotychczasową
        // kontrolę po pobraniu - metadane nie są dostępne dla każdej wiadomości.
        const announcedSize = knownSize(message._data?.size);
        if (announcedSize !== null && this.isTooLarge(announcedSize)) {
            return this.tooLarge(meta, announcedSize);
        }

        let outcome: FetchOutcome;
        try {
            outcome = await this.fetch(message, target, options);
        } catch (err) {
            const reason = describeShort(err);
            this.noteFailure(target, reason, err, message);
            return { path: null, name: null, skipped: { ...meta, reason: `błąd pobierania: ${reason}` } };
        }

        const media = outcome.media;
        if (!media?.data) {
            // Powód z przeglądarki wchodzi do notatki, żeby po archiwum dało
            // się odróżnić wygasłe media od zerwanego łącza serwera.
            const reason = outcome.why
                ? `nie udało się pobrać pliku: ${outcome.why}`
                : 'nie udało się pobrać pliku';
            this.noteFailure(target, reason, undefined, message);
            return { path: null, name: null, skipped: { ...meta, reason } };
        }

        // base64 → bajty: każde 4 znaki to 3 bajty.
        const sizeBytes = Math.round((media.data.length * 3) / 4);
        meta.bytes = sizeBytes;
        meta.filename = meta.filename ?? media.filename ?? null;

        if (this.isTooLarge(sizeBytes)) return this.tooLarge(meta, sizeBytes);

        try {
            const fileName = buildFileName(message, media);
            const absolute = path.join(target.mediaDir, fileName);
            await ensureDir(target.mediaDir);
            await fs.writeFile(absolute, Buffer.from(media.data, 'base64'));

            return {
                path: path.relative(target.chatDir, absolute),
                name: meta.filename,
                skipped: null,
            };
        } catch (err) {
            const reason = describeShort(err);
            this.noteFailure(target, reason, err, message);
            return { path: null, name: null, skipped: { ...meta, reason: `błąd zapisu: ${reason}` } };
        }
    }

    private isTooLarge(sizeBytes: number): boolean {
        return sizeBytes > this.config.maxMediaSizeMb * 1024 * 1024;
    }

    private tooLarge(meta: SkippedMedia, sizeBytes: number): MediaResult {
        const sizeMb = sizeBytes / (1024 * 1024);
        log.info(
            `Pominięto plik - za duży: ${sizeMb.toFixed(1)} MB (limit: ${this.config.maxMediaSizeMb} MB)`,
        );
        return {
            path: null,
            name: null,
            skipped: {
                ...meta,
                bytes: sizeBytes,
                reason: `plik ponad limit ${this.config.maxMediaSizeMb} MB`,
            },
        };
    }

    /**
     * Pobranie z powtórkami. Pusty wynik nie znaczy jeszcze, że pliku nie ma:
     * WhatsApp Web często dopiero go ściąga. Relacje z przeglądu bywa, że nie
     * ma w pamięci przeglądarki wśród zwykłych wiadomości - wtedy szukamy ich
     * w kolekcji statusów, a między podejściami odświeżamy samą wiadomość.
     */
    private async fetch(
        message: WaMessage,
        target: MediaTarget,
        options: DownloadOptions = {},
    ): Promise<FetchOutcome> {
        let firstError: unknown = null;
        // Powód z ostatniego podejścia jest najbliższy prawdy: wcześniejsze
        // mogły jeszcze mówić "pobieranie trwa", a to stan przejściowy.
        let why: string | null = null;

        const tryOnce = async (
            load: () => Promise<DownloadedMedia | null>,
        ): Promise<DownloadedMedia | null> => {
            try {
                const media = await load();
                return media?.data ? media : null;
            } catch (err) {
                firstError ??= err;
                why = describeShort(err);
                return null;
            }
        };

        const viaLibrary = (): Promise<DownloadedMedia | null> =>
            tryOnce(async () => (await message.downloadMedia()) as DownloadedMedia | null);
        const viaStore = async (): Promise<DownloadedMedia | null> =>
            tryOnce(async () => {
                const result = await downloadMediaFromStore(message, {
                    ...(options.waitForStageMs === undefined
                        ? {}
                        : { waitForStageMs: options.waitForStageMs }),
                });
                if (result.why) why = result.why;
                return result.media;
            });

        // Relacji biblioteka szuka wyłącznie w Store.Msg, gdzie po przeglądzie
        // zwykle ich już nie ma - dla nich zaczynamy od odczytu wprost
        // z kolekcji. Dla zwykłych wiadomości odwrotnie: tańsze wywołanie
        // biblioteki idzie pierwsze.
        const order = target.isStatus ? [viaStore, viaLibrary] : [viaLibrary, viaStore];

        const waits = this.retriesLeft(target) > 0 ? RETRY_WAITS_MS : RETRY_WAITS_MS.slice(0, 1);

        for (const [attempt, waitMs] of waits.entries()) {
            if (waitMs > 0) await sleep(waitMs);

            for (const attemptDownload of order) {
                const media = await attemptDownload();
                if (media) return { media, why: null };
            }

            // Odświeżenie modelu kosztuje osobne zapytanie do strony, więc
            // sięgamy po nie dopiero, gdy zwykłe pobranie zawiodło raz.
            if (attempt > 0 && typeof message.reload === 'function') {
                const fresh = await tryOnce(async () => {
                    const reloaded = (await message.reload()) as WaMessage | null;
                    return reloaded ? ((await reloaded.downloadMedia()) as DownloadedMedia | null) : null;
                });
                if (fresh) return { media: fresh, why: null };
            }
        }

        if (waits.length > 1) this.countRetriedFailure(target);

        if (firstError) {
            log.quiet(firstError, {
                stage: 'pobieranie mediów',
                chat: target.label,
                messageId: messageKey(message),
                messageType: message.type,
            });
        }
        return { media: null, why };
    }

    /**
     * Komunikat na ekranie ma nie zalewać, ale też nie znikać na zawsze.
     *
     * Wcześniej pierwsza awaria w czacie wyciszała go do końca procesu -
     * także wtedy, gdy pół dnia później zaczynało się dziać coś zupełnie
     * innego. Teraz powtarzamy się dopiero, gdy zmienia się powód albo gdy
     * mija okno CHAT_WINDOW_MS.
     */
    private noteFailure(target: MediaTarget, reason: string, err?: unknown, message?: WaMessage): void {
        if (err !== undefined) {
            log.quiet(err, {
                stage: 'pobieranie mediów',
                chat: target.label,
                messageId: message ? messageKey(message) : null,
                messageType: message?.type ?? null,
            });
        }

        const window = this.windowFor(target);
        if (window.reportedReason === reason) return;
        window.reportedReason = reason;

        log.warn(
            `Nie udało się pobrać mediów w "${target.label}": ${reason}` +
                ' - notatka zostaje w archiwum, plik wraca do kolejki ponowień',
        );
    }
}

/**
 * Czy warto wrócić do tego pliku później.
 *
 * Wyłączony typ i przekroczony limit to decyzje z konfiguracji - one się same
 * nie zmienią. Reszta to chwilowa niedyspozycja WhatsAppa albo dysku, więc
 * taka wiadomość trafia do kolejki ponowień.
 */
export function isRecoverableMediaFailure(reason: string): boolean {
    return (
        reason.startsWith('nie udało się pobrać') ||
        reason.startsWith('błąd pobierania') ||
        reason.startsWith('błąd zapisu')
    );
}

/** Wiarygodny rozmiar z metadanych albo null, gdy WhatsApp go nie podał. */
function knownSize(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Nazwa pliku na dysku: czas, kawałek identyfikatora i rozszerzenie z MIME. */
export function buildFileName(message: WaMessage, media: DownloadedMedia): string {
    const mime = media.mimetype ?? 'application/octet-stream';
    const ext = (mime.split('/')[1] ?? 'bin').split(';')[0]?.replace('jpeg', 'jpg') ?? 'bin';

    const rawId = message.id?.id ?? String(Date.now());
    const shortId = rawId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'plik';

    return `${Date.now()}_${shortId}.${ext.replace(/[^a-z0-9]/gi, '') || 'bin'}`;
}

/**
 * Pobiera plik wprost z modelu w Store, z pominięciem Message.downloadMedia().
 *
 * Robi cztery rzeczy, których biblioteka nie robi, a bez których w archiwum
 * zostawały notatki "nie udało się pobrać pliku":
 *  - szuka wiadomości także w Store.Status (relacje z przeglądu) i przez
 *    getMessagesById (wiadomości nadrobione, których nie ma już w pamięci);
 *  - czeka na koniec pobierania zamiast oddawać pustkę przy "FETCHING";
 *  - prosi telefon o ponowne wysłanie wygasłego pliku ("REUPLOADING")
 *    i czeka na wynik tej prośby;
 *  - nazywa powód niepowodzenia, zamiast oddawać samo "nie ma".
 */
export async function downloadMediaFromStore(
    message: WaMessage,
    options: { waitForStageMs?: number } = {},
): Promise<StoreDownload> {
    // Relacje z getBroadcasts() nie mają id._serialized - biblioteka buduje je
    // z surowego serialize(). Dlatego szukamy modelu po dowolnej postaci
    // identyfikatora, jaka nam została, w tym po samym skrócie wiadomości.
    const wanted = [messageKey(message), messageHash(message)].filter(
        (value): value is string => Boolean(value),
    );
    if (wanted.length === 0) {
        return { media: null, stage: null, why: 'wiadomość nie ma identyfikatora WhatsAppa' };
    }

    const page = message.client?.pupPage;
    if (!page) return { media: null, stage: null, why: 'brak otwartej strony WhatsApp Web' };

    const waitMs = options.waitForStageMs ?? STAGE_WAIT_MS;

    return page.evaluate(async (wantedIds: string[], stageWaitMs: number): Promise<StoreDownload> => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const win = globalThis as any;
        const Store = win.Store;
        const fail = (why: string, stage: string | null = null): StoreDownload => ({
            media: null,
            stage,
            why,
        });

        if (!Store) return fail('przeglądarka nie ma jeszcze Store WhatsAppa');

        // Model w przeglądarce ma poprawny MsgKey, więc porównujemy go
        // ze wszystkim, czym dysponujemy po stronie Node.
        const matches = (value: any): boolean => {
            const id = value?.id;
            if (!id) return false;
            const forms = [id._serialized, id.id, typeof id.toString === 'function' ? id.toString() : null];
            return forms.some((form) => typeof form === 'string' && wantedIds.includes(form));
        };

        const modelsOf = (value: any): any[] => {
            if (!value) return [];
            if (Array.isArray(value)) return value;
            try {
                if (typeof value.getModelsArray === 'function') return value.getModelsArray();
            } catch {
                /* następny kształt */
            }
            if (Array.isArray(value.models)) return value.models;
            if (Array.isArray(value._models)) return value._models;
            return [];
        };

        let msg: any = null;
        for (const wantedId of wantedIds) {
            try {
                msg = Store.Msg?.get?.(wantedId) ?? null;
            } catch {
                /* relacji zwykle tu nie ma */
            }
            if (msg) break;
        }

        if (!msg) {
            let statuses: any[] = [];
            try {
                statuses = Store.Status?.getModelsArray?.() ?? [];
            } catch {
                statuses = [];
            }

            for (const status of statuses) {
                // Nazwy prywatnych pól zmieniają się między wydaniami WhatsAppa.
                // Najpierw znane warianty, potem pozostałe pola z "msg" w nazwie.
                const sources: any[] = [status?.msgs, status?._msgs, status?.msgCollection, status?._msgCollection];
                for (const [key, value] of Object.entries(status ?? {})) {
                    if (/msg/i.test(key)) sources.push(value);
                }
                for (const source of sources) {
                    msg = modelsOf(source).find((candidate) => matches(candidate)) ?? null;
                    if (msg) break;
                }
                if (msg) break;
            }
        }

        // Wiadomość nadrobiona po przerwie bywa poza pamięcią przeglądarki.
        // Ta sama droga, którą biblioteka dociąga pojedyncze wiadomości.
        if (!msg) {
            for (const wantedId of wantedIds) {
                try {
                    const found = await Store.Msg?.getMessagesById?.([wantedId]);
                    msg = found?.messages?.[0] ?? null;
                } catch {
                    /* następny identyfikator */
                }
                if (msg) break;
            }
        }

        if (!msg) return fail('wiadomości nie ma już w pamięci przeglądarki');

        const wait = (ms: number): Promise<void> =>
            new Promise((resolve) => setTimeout(resolve, ms));
        const stageNow = (): string => String(msg?.mediaData?.mediaStage ?? '');

        // "REUPLOADING" znaczy, że plik wygasł na serwerze i telefon musi go
        // wysłać jeszcze raz. Biblioteka poddaje się w tym miejscu; my o to
        // wysłanie prosimy (rmrReason: 1) i czekamy na jego skutek.
        let requestError: string | null = null;
        if (stageNow() !== 'RESOLVED' && typeof msg.downloadMedia === 'function') {
            try {
                await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
            } catch (err: any) {
                // O tym, czy coś z tego wyszło, decyduje etap poniżej, ale
                // treść błędu bywa jedyną informacją o odciętym połączeniu.
                requestError = String(err?.message ?? err ?? '').slice(0, 200) || null;
            }
        }

        // Pobieranie trwa poza tym wywołaniem, więc czekamy na jego koniec.
        const deadline = Date.now() + stageWaitMs;
        while (
            Date.now() < deadline &&
            (stageNow() === 'FETCHING' || stageNow() === 'REUPLOADING')
        ) {
            await wait(400);
        }

        const found = (data: unknown): DownloadedMedia | null =>
            typeof data === 'string' && data.length > 0
                ? {
                      data,
                      mimetype: msg.mimetype,
                      filename: msg.filename,
                      filesize: msg.size,
                  }
                : null;

        /**
         * Rozszyfrowany plik, który przeglądarka trzyma po udanym pobraniu -
         * dokładnie ten, którym sama rysuje zdjęcie w oknie rozmowy.
         *
         * Bierzemy go przed DownloadManagerem, bo nie wymaga ani sieci, ani
         * kompletu metadanych (directPath, mediaKey, encFilehash). Wygasłe
         * i dosłane po ponownym wysłaniu media potrafią części z nich nie
         * mieć - i właśnie na tym kończyło się notatką "nie udało się
         * pobrać pliku", mimo że zdjęcie było widoczne w WhatsAppie.
         */
        const blobOf = (holder: any): unknown => {
            if (!holder) return null;
            if (typeof win.Blob === 'function' && holder instanceof win.Blob) return holder;
            for (const key of ['_blob', 'forceableBlob', 'blob']) {
                const value = holder[key];
                if (value) return value;
            }
            for (const key of ['forceToBlob', 'toBlob']) {
                if (typeof holder[key] === 'function') {
                    try {
                        return holder[key]();
                    } catch {
                        /* następna droga */
                    }
                }
            }
            return null;
        };

        const blob = await Promise.resolve(blobOf(msg.mediaData?.mediaBlob)).catch(() => null);
        if (blob) {
            const fromBlob = await new Promise<string | null>((resolve) => {
                try {
                    // FileReader jest globalną przeglądarki, a ten kod
                    // kompiluje się w typach Node - stąd droga przez win.
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
            const media = found(fromBlob);
            if (media) return { media, stage: stageNow(), why: null };
        }

        // Od tego miejsca każde wyjście jest porażką i ma nazwać powód.
        // Wcześniej wszystkie zlewały się w jedno "nie udało się pobrać".
        const stage = stageNow();
        if (stage === 'REUPLOADING') {
            return fail('media wygasły i czekają, aż telefon wyśle je ponownie', stage);
        }
        if (stage === 'FETCHING') {
            return fail(`pobieranie nie skończyło się w ${Math.round(stageWaitMs / 1000)} s`, stage);
        }
        if (stage.includes('ERROR')) {
            return fail(`WhatsApp zgłosił błąd pobierania (${stage})`, stage);
        }
        if (typeof Store.DownloadManager?.downloadAndMaybeDecrypt !== 'function') {
            return fail('przeglądarka nie udostępnia DownloadManagera', stage);
        }
        if (!msg.directPath || !msg.mediaKey) {
            // Bez tych dwóch pól nie ma czego odszyfrować, a przeglądarka nie
            // ma gotowego blobu - plik przepadł po stronie WhatsAppa.
            return fail(
                'WhatsApp nie ma już adresu ani klucza do tego pliku' +
                    (requestError ? ` (${requestError})` : ''),
                stage,
            );
        }

        let decrypted: unknown;
        try {
            decrypted = await Store.DownloadManager.downloadAndMaybeDecrypt({
                directPath: msg.directPath,
                encFilehash: msg.encFilehash,
                filehash: msg.filehash,
                mediaKey: msg.mediaKey,
                mediaKeyTimestamp: msg.mediaKeyTimestamp,
                type: msg.type,
                signal: new AbortController().signal,
                downloadQpl: {
                    addAnnotations() {
                        return this;
                    },
                    addPoint() {
                        return this;
                    },
                },
            });
        } catch (err: any) {
            // Tu wychodzi najczęstsza przyczyna po stronie serwera: odcięty
            // dostęp do mmg.whatsapp.net albo 404 na wygasłym directPath.
            const status = err?.status ?? err?.statusCode;
            const detail = String(err?.message ?? err ?? 'bez treści').slice(0, 200);
            return fail(
                status
                    ? `serwer mediów WhatsAppa odpowiedział ${String(status)}`
                    : `pobieranie z serwera mediów nie doszło do skutku: ${detail}`,
                stage,
            );
        }

        const media = found(await win.WWebJS.arrayBufferToBase64Async(decrypted));
        return media
            ? { media, stage, why: null }
            : fail('serwer mediów oddał pustą odpowiedź', stage);
        /* eslint-enable @typescript-eslint/no-explicit-any */
    }, wanted, waitMs);
}

function describeShort(err: unknown): string {
    if (err instanceof Error) {
        const name = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
        return `${name}${err.message || '(bez treści)'}`;
    }
    return String(err ?? '(bez treści)');
}
