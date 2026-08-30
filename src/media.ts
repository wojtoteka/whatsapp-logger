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
 * Ile plików w jednym czacie wolno ponawiać w czasie jednego przebiegu.
 * Stara historia bywa nie do odzyskania i nie ma sensu dokładać do niej
 * kilku sekund na każdą wiadomość.
 */
const RETRIED_FAILURES_PER_CHAT = 5;

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

export interface MediaResult {
    /** Ścieżka do pliku względem folderu czatu albo null. */
    path: string | null;
    /** Oryginalna nazwa pliku, jeśli WhatsApp ją podał. */
    name: string | null;
    skipped: SkippedMedia | null;
}

const NOTHING: MediaResult = { path: null, name: null, skipped: null };

export class MediaDownloader {
    /** Czaty, w których pobieranie już raz padło - komunikat leci raz. */
    private readonly failedChats = new Set<string>();
    /** Ile plików w danym czacie ponawialiśmy bez skutku. */
    private readonly retriedFailures = new Map<string, number>();

    constructor(private readonly config: Config) {}

    private retriesLeft(target: MediaTarget): number {
        return RETRIED_FAILURES_PER_CHAT - (this.retriedFailures.get(target.label) ?? 0);
    }

    private countRetriedFailure(target: MediaTarget): void {
        this.retriedFailures.set(target.label, (this.retriedFailures.get(target.label) ?? 0) + 1);
    }

    /**
     * Pobiera i zapisuje plik z wiadomości. Zawsze zwraca wynik - błąd
     * pobierania kończy się notatką w archiwum, a nie wyjątkiem.
     */
    async download(message: WaMessage, target: MediaTarget): Promise<MediaResult> {
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

        let media: DownloadedMedia | null;
        try {
            media = await this.fetch(message, target);
        } catch (err) {
            const reason = describeShort(err);
            this.noteFailure(target, reason, err, message);
            return { path: null, name: null, skipped: { ...meta, reason: `błąd pobierania: ${reason}` } };
        }

        if (!media?.data) {
            this.noteFailure(target, 'WhatsApp nie oddał pliku');
            return { path: null, name: null, skipped: { ...meta, reason: 'nie udało się pobrać pliku' } };
        }

        // base64 → bajty: każde 4 znaki to 3 bajty.
        const sizeBytes = Math.round((media.data.length * 3) / 4);
        meta.bytes = sizeBytes;
        meta.filename = meta.filename ?? media.filename ?? null;

        const sizeMb = sizeBytes / (1024 * 1024);
        if (sizeMb > this.config.maxMediaSizeMb) {
            log.info(
                `Pominięto plik - za duży: ${sizeMb.toFixed(1)} MB (limit: ${this.config.maxMediaSizeMb} MB)`,
            );
            return {
                path: null,
                name: null,
                skipped: { ...meta, reason: `plik ponad limit ${this.config.maxMediaSizeMb} MB` },
            };
        }

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

    /**
     * Pobranie z powtórkami. Pusty wynik nie znaczy jeszcze, że pliku nie ma:
     * WhatsApp Web często dopiero go ściąga. Relacje z przeglądu bywa, że nie
     * ma w pamięci przeglądarki wśród zwykłych wiadomości - wtedy szukamy ich
     * w kolekcji statusów, a między podejściami odświeżamy samą wiadomość.
     */
    private async fetch(message: WaMessage, target: MediaTarget): Promise<DownloadedMedia | null> {
        let firstError: unknown = null;

        const tryOnce = async (
            load: () => Promise<DownloadedMedia | null>,
        ): Promise<DownloadedMedia | null> => {
            try {
                const media = await load();
                return media?.data ? media : null;
            } catch (err) {
                firstError ??= err;
                return null;
            }
        };

        const waits = this.retriesLeft(target) > 0 ? RETRY_WAITS_MS : RETRY_WAITS_MS.slice(0, 1);

        for (const [attempt, waitMs] of waits.entries()) {
            if (waitMs > 0) await sleep(waitMs);

            const direct = await tryOnce(
                async () => (await message.downloadMedia()) as DownloadedMedia | null,
            );
            if (direct) return direct;

            if (target.isStatus) {
                const status = await tryOnce(() => downloadStatusMedia(message));
                if (status) return status;
            }

            // Odświeżenie modelu kosztuje osobne zapytanie do strony, więc
            // sięgamy po nie dopiero, gdy zwykłe pobranie zawiodło raz.
            if (attempt > 0 && typeof message.reload === 'function') {
                const fresh = await tryOnce(async () => {
                    const reloaded = (await message.reload()) as WaMessage | null;
                    return reloaded ? ((await reloaded.downloadMedia()) as DownloadedMedia | null) : null;
                });
                if (fresh) return fresh;
            }
        }

        if (waits.length > 1) this.countRetriedFailure(target);

        if (firstError && !this.failedChats.has(target.label)) {
            log.quiet(firstError, {
                stage: 'pobieranie mediów',
                chat: target.label,
                messageId: messageKey(message),
                messageType: message.type,
            });
        }
        return null;
    }

    /**
     * Jeden komunikat na czat zamiast jednego na wiadomość - relacje
     * potrafią przyjść paczką i to samo leciało kilkanaście razy pod rząd.
     */
    private noteFailure(target: MediaTarget, reason: string, err?: unknown, message?: WaMessage): void {
        if (this.failedChats.has(target.label)) return;
        this.failedChats.add(target.label);

        if (err !== undefined) {
            log.quiet(err, {
                stage: 'pobieranie mediów',
                chat: target.label,
                messageId: message ? messageKey(message) : null,
                messageType: message?.type ?? null,
            });
        }
        log.warn(
            `Nie udało się pobrać mediów w "${target.label}": ${reason}` +
                ' - kolejnych z tego czatu już nie wypisuję, notatka zostaje w archiwum',
        );
    }
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
 * Pobiera media relacji wprost z modelu w Store.Status. whatsapp-web.js
 * szuka wyłącznie w Store.Msg, gdzie relacji z przeglądu często już nie ma,
 * mimo że w samym WhatsAppie nadal są widoczne.
 */
export async function downloadStatusMedia(message: WaMessage): Promise<DownloadedMedia | null> {
    // Relacje z getBroadcasts() nie mają id._serialized - biblioteka buduje je
    // z surowego serialize(). Dlatego szukamy modelu po dowolnej postaci
    // identyfikatora, jaka nam została, w tym po samym skrócie wiadomości.
    const wanted = [messageKey(message), messageHash(message)].filter(
        (value): value is string => Boolean(value),
    );
    const page = message.client?.pupPage;
    if (wanted.length === 0 || !page) return null;

    return page.evaluate(async (wantedIds: string[]): Promise<DownloadedMedia | null> => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const win = globalThis as any;
        const Store = win.Store;
        if (!Store) return null;

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

        if (!msg?.mediaData) return null;
        if (msg.mediaData.mediaStage === 'REUPLOADING') return null;

        if (msg.mediaData.mediaStage !== 'RESOLVED' && typeof msg.downloadMedia === 'function') {
            await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
        }

        const stage = String(msg.mediaData.mediaStage ?? '');
        if (stage.includes('ERROR') || stage === 'FETCHING' || stage === 'REUPLOADING') return null;

        const decrypted = await Store.DownloadManager.downloadAndMaybeDecrypt({
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

        return {
            data: await win.WWebJS.arrayBufferToBase64Async(decrypted),
            mimetype: msg.mimetype,
            filename: msg.filename,
            filesize: msg.size,
        };
        /* eslint-enable @typescript-eslint/no-explicit-any */
    }, wanted);
}

function describeShort(err: unknown): string {
    if (err instanceof Error) {
        const name = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
        return `${name}${err.message || '(bez treści)'}`;
    }
    return String(err ?? '(bez treści)');
}
