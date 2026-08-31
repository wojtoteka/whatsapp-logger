// Diagnoza pobierania plików - polecenie "npm start -- --sprawdz-media".
//
// Notatka w archiwum mówi, co się nie udało przy jednym pliku. To polecenie
// odpowiada na pytanie o klasę: czy WhatsApp nie chce oddać konkretnego pliku,
// czy serwer w ogóle nie dosięga serwera mediów. To są dwie zupełnie różne
// awarie, a z poziomu jednej notatki wyglądają identycznie.
//
// Nic tu nie zapisuje ani nie kasuje - same odczyty.

import { downloadMediaFromStore } from './media';
import { messageKey } from './identity';
import { MediaRetryQueue } from './mediaRetry';
import { ensurePageAccess, PAGE_HELPER, pageAccessLine } from './pageStore';
import { isStatusChat } from './statuses';
import type { WaClient, WaMessage } from './types';
import { listStatusMessages } from './waClient';

/** Ile pozycji z kolejki i ile relacji brać pod lupę. */
const SAMPLE = 3;

/** Ile czekać na etap pobierania przy diagnozie - jak w przeglądzie zaległości. */
const STAGE_WAIT_MS = 45_000;

export interface MediaProbe {
    źródło: 'kolejka' | 'relacja';
    id: string;
    typ: string;
    /** Co widać w modelu przeglądarki, zanim cokolwiek pobierzemy. */
    model: string;
    /** Wynik message.downloadMedia() - tej samej drogi, co w starej wersji. */
    biblioteka: string;
    /** Wynik odczytu wprost ze Store razem z powodem. */
    store: string;
}

export interface MediaCheckResult {
    /** Czy strona WhatsApp Weba dosięga serwera plików. */
    siec: string;
    /** Skąd bierzemy kolekcje WhatsAppa - i czy w ogóle je mamy. */
    wnetrze: string;
    probki: MediaProbe[];
    /** Ile wiadomości czeka w kolejce ponowień. */
    wKolejce: number;
    uwagi: string[];
}

/**
 * Sprawdza drogę pobierania plików na żywej sesji WhatsApp Web.
 *
 * Kolejność jest celowa: najpierw sieć, bo jeśli Chromium nie dosięga
 * `mmg.whatsapp.net`, to każda pojedyncza porażka pliku jest tylko objawem
 * i nie ma sensu czytać jej osobno.
 */
export async function checkMedia(client: WaClient, logsDir: string): Promise<MediaCheckResult> {
    const access = await ensurePageAccess(client);

    const result: MediaCheckResult = {
        siec: await probeMediaHost(client),
        wnetrze: pageAccessLine(access),
        probki: [],
        wKolejce: 0,
        uwagi: [],
    };

    const queue = new MediaRetryQueue(logsDir);
    result.wKolejce = await queue.size();

    for (const entry of await queue.due(SAMPLE)) {
        const message = await findMessage(client, entry.messageId, isStatusChat(entry.chatId));
        if (!message) {
            result.probki.push({
                źródło: 'kolejka',
                id: entry.messageId,
                typ: entry.type,
                model: 'WhatsApp nie zna już tej wiadomości',
                biblioteka: '-',
                store: '-',
            });
            continue;
        }
        result.probki.push(await probeMessage(message, 'kolejka', entry.type));
    }

    // Relacje sprawdzamy osobno: idą inną drogą niż zwykłe wiadomości
    // i to właśnie na nich najczęściej widać, że kolekcja statusów jest pusta.
    const statuses = (await listStatusMessages(client)) ?? [];
    const zPlikiem = statuses.filter((message) => message.hasMedia).slice(0, SAMPLE);

    if (statuses.length === 0) {
        result.uwagi.push(
            'Kolekcja Store.Status jest pusta - ta sesja WhatsApp Web nie widzi żadnych relacji. ' +
                'Relacje żyją dobę; jeżeli w telefonie są, a tutaj ich nie ma, strona ich jeszcze nie wczytała.',
        );
    } else if (zPlikiem.length === 0) {
        result.uwagi.push(
            `Relacji jest ${String(statuses.length)}, ale żadna nie ma pliku (same tekstowe).`,
        );
    }

    for (const message of zPlikiem) {
        result.probki.push(await probeMessage(message, 'relacja', message.type));
    }

    if (!access.ready) {
        result.uwagi.push(
            'Strona nie udostępnia kolekcji WhatsAppa. Tak wygląda przeładowana strona ' +
                'WhatsApp Weba, zanim wróci do siebie - wtedy nie zejdzie ani jeden plik.',
        );
    }

    if (result.probki.length === 0) {
        result.uwagi.push('Nie ma czego sprawdzić - kolejka ponowień jest pusta i nie ma relacji z plikiem.');
    }

    return result;
}

/** Jedna wiadomość przepuszczona przez obie drogi pobierania. */
async function probeMessage(
    message: WaMessage,
    źródło: MediaProbe['źródło'],
    typ: string,
): Promise<MediaProbe> {
    const probe: MediaProbe = {
        źródło,
        id: messageKey(message) ?? '(bez identyfikatora)',
        typ,
        model: await describeModel(message),
        biblioteka: '-',
        store: '-',
    };

    try {
        const media = (await message.downloadMedia()) as { data?: string } | null;
        probe.biblioteka = media?.data
            ? `plik przyszedł (${formatBytes((media.data.length * 3) / 4)})`
            : 'pusto (bez błędu)';
    } catch (err) {
        probe.biblioteka = `błąd: ${short(err)}`;
    }

    try {
        const wynik = await downloadMediaFromStore(message, { waitForStageMs: STAGE_WAIT_MS });
        probe.store = wynik.media?.data
            ? `plik przyszedł (${formatBytes((wynik.media.data.length * 3) / 4)})`
            : `${wynik.why ?? 'bez powodu'}${wynik.stage ? ` [etap: ${wynik.stage}]` : ''}`;
    } catch (err) {
        probe.store = `błąd: ${short(err)}`;
    }

    return probe;
}

/**
 * Co WhatsApp Web trzyma o tym pliku, zanim go tkniemy.
 *
 * Sam etap nie wystarcza: brak `directPath` albo `mediaKey` znaczy, że nie ma
 * czego odszyfrować, a gotowy `mediaBlob` znaczy, że plik jest na miejscu
 * i wystarczy go przepisać.
 */
async function describeModel(message: WaMessage): Promise<string> {
    const page = message.client?.pupPage;
    const id = messageKey(message);
    if (!page || !id) return 'brak strony WhatsApp Web';

    try {
        return await page.evaluate((wanted: string, helperName: string): string => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const win = globalThis as any;
            const safe = <T>(read: () => T, fallback: T): T => {
                try {
                    return read();
                } catch {
                    return fallback;
                }
            };

            const store = safe(() => win[helperName]?.store?.(), null) ?? safe(() => win.Store, null);
            const msg = safe(() => store?.Msg?.get?.(wanted), null);
            if (!msg) return 'nie ma go w Store.Msg';

            const czesci = [
                `etap: ${safe(() => String(msg.mediaData?.mediaStage ?? '(brak)'), '(nie do odczytu)')}`,
                safe(() => msg.directPath, null) ? 'directPath jest' : 'directPath BRAK',
                safe(() => msg.mediaKey, null) ? 'mediaKey jest' : 'mediaKey BRAK',
                safe(() => msg.mediaData?.mediaBlob, null)
                    ? 'gotowy plik w przeglądarce'
                    : 'bez gotowego pliku',
            ];
            return czesci.join(', ');
            /* eslint-enable @typescript-eslint/no-explicit-any */
        }, id, PAGE_HELPER);
    } catch (err) {
        return `nie do odczytu: ${short(err)}`;
    }
}

/**
 * Czy Chromium dosięga serwera plików WhatsAppa.
 *
 * Pliki idą z innego hosta niż sama strona, więc działający WhatsApp Web nie
 * dowodzi niczego o mediach. Zapytanie leci w trybie "no-cors": odpowiedź jest
 * nieprzezroczysta, ale samo jej otrzymanie znaczy, że pakiet doszedł i wrócił.
 * Wyjątek znaczy, że nie doszedł - zapora, DNS albo proxy.
 */
async function probeMediaHost(client: WaClient): Promise<string> {
    const page = client.pupPage;
    if (!page) return 'nie wiem - nie ma otwartej strony WhatsApp Web';

    try {
        return await page.evaluate(async (): Promise<string> => {
            const host = 'https://mmg.whatsapp.net/';
            const start = Date.now();
            try {
                await fetch(host, { method: 'GET', mode: 'no-cors' });
                return `mmg.whatsapp.net odpowiada (${String(Date.now() - start)} ms)`;
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                return `mmg.whatsapp.net NIE odpowiada: ${detail}`;
            }
        });
    } catch (err) {
        return `nie udało się sprawdzić: ${short(err)}`;
    }
}

/** Wiadomość do zbadania - relacje leżą w innej kolekcji niż rozmowy. */
async function findMessage(
    client: WaClient,
    messageId: string,
    isStatus: boolean,
): Promise<WaMessage | null> {
    if (isStatus) {
        const statuses = (await listStatusMessages(client)) ?? [];
        return statuses.find((candidate) => messageKey(candidate) === messageId) ?? null;
    }

    if (typeof client.getMessageById !== 'function') return null;
    try {
        return (await client.getMessageById(messageId)) as WaMessage | null;
    } catch {
        return null;
    }
}

function formatBytes(bytes: number): string {
    return bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.round(bytes / 1024)} kB`;
}

function short(err: unknown): string {
    if (err instanceof Error) {
        const name = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
        return `${name}${err.message || '(bez treści)'}`;
    }
    return String(err ?? '(bez treści)');
}
