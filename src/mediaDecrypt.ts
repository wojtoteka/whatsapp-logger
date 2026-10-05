// Pobieranie i odszyfrowanie pliku z serwera mediów WhatsAppa po stronie Node.
//
// Od jesieni 2026 WhatsApp Web odrzuca odpowiedź własnego serwera mediów
// komunikatem "Unexpected mimetype application/octet-stream for media type
// image": serwer oddaje zaszyfrowany plik jako octet-stream, a downloader
// przeglądarki oczekuje typu zgodnego z rodzajem mediów. Dokumenty
// przechodziły, zdjęcia, filmy i głosówki - nie. Zaszyfrowany plik i klucz
// do niego są jednak w porządku, więc robimy to samo, co przeglądarka:
// ściągamy plik z mmg.whatsapp.net i odszyfrowujemy go tutaj.
//
// Schemat szyfrowania (taki sam we wszystkich klientach WhatsAppa):
//  - HKDF-SHA256(mediaKey, info zależne od typu) daje 112 bajtów:
//    iv (16), klucz AES (32), klucz HMAC (32), reszta nieużywana;
//  - plik = AES-256-CBC(dane) + pierwsze 10 bajtów HMAC-SHA256(iv + szyfrogram).

import crypto from 'node:crypto';
import type { DownloadedMedia } from './types';

/** Komplet danych z modelu wiadomości, wystarczający do pobrania pliku. */
export interface MediaKeys {
    directPath: string | null;
    /** Pełny adres pliku, gdy model go ma - droga awaryjna dla directPath. */
    url: string | null;
    /** mediaKey w base64. */
    mediaKey: string;
    /** Typ wiadomości z WhatsAppa: image, video, ptt, document, sticker... */
    type: string | null;
    mimetype: string | null;
    filename: string | null;
    size: number | null;
    /** SHA-256 zaszyfrowanego pliku w base64, gdy model go podał. */
    encFilehash: string | null;
}

export const MEDIA_HOST = 'mmg.whatsapp.net';

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAC_LENGTH = 10;

/** Info do HKDF - zależy od rodzaju mediów, nie od konkretnego MIME. */
export function hkdfInfoFor(type: string | null, mimetype: string | null): string {
    switch (type) {
        case 'image':
        case 'sticker':
            return 'WhatsApp Image Keys';
        case 'video':
        case 'gif':
        case 'ptv':
            return 'WhatsApp Video Keys';
        case 'audio':
        case 'ptt':
            return 'WhatsApp Audio Keys';
        case 'document':
            return 'WhatsApp Document Keys';
        default:
            break;
    }
    const kind = (mimetype ?? '').split('/')[0];
    if (kind === 'image') return 'WhatsApp Image Keys';
    if (kind === 'video') return 'WhatsApp Video Keys';
    if (kind === 'audio') return 'WhatsApp Audio Keys';
    return 'WhatsApp Document Keys';
}

function expandKey(mediaKey: Buffer, info: string): { iv: Buffer; cipherKey: Buffer; macKey: Buffer } {
    const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), info, 112));
    return {
        iv: expanded.subarray(0, 16),
        cipherKey: expanded.subarray(16, 48),
        macKey: expanded.subarray(48, 80),
    };
}

/** Odszyfrowuje plik z serwera mediów. Rzuca, gdy podpis się nie zgadza. */
export function decryptMedia(encrypted: Buffer, mediaKeyBase64: string, info: string): Buffer {
    const mediaKey = Buffer.from(mediaKeyBase64, 'base64');
    if (mediaKey.length !== 32) throw new Error(`mediaKey ma ${mediaKey.length} bajtów zamiast 32`);
    if (encrypted.length <= MAC_LENGTH) throw new Error('serwer mediów oddał za krótki plik');

    const { iv, cipherKey, macKey } = expandKey(mediaKey, info);
    const body = encrypted.subarray(0, encrypted.length - MAC_LENGTH);
    const mac = encrypted.subarray(encrypted.length - MAC_LENGTH);

    const expected = crypto
        .createHmac('sha256', macKey)
        .update(iv)
        .update(body)
        .digest()
        .subarray(0, MAC_LENGTH);
    if (!crypto.timingSafeEqual(mac, expected)) {
        throw new Error('podpis pliku się nie zgadza (zły klucz albo uszkodzony plik)');
    }

    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Odwrotność decryptMedia - potrzebna testom, nie produkcji. */
export function encryptMedia(plain: Buffer, mediaKeyBase64: string, info: string): Buffer {
    const { iv, cipherKey, macKey } = expandKey(Buffer.from(mediaKeyBase64, 'base64'), info);
    const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const mac = crypto
        .createHmac('sha256', macKey)
        .update(iv)
        .update(body)
        .digest()
        .subarray(0, MAC_LENGTH);
    return Buffer.concat([body, mac]);
}

/**
 * Adresy, pod którymi szukamy pliku - najpierw directPath na stałym hoście,
 * potem pełny adres z modelu. Przyjmujemy wyłącznie serwery WhatsAppa.
 */
export function candidateUrls(keys: MediaKeys): string[] {
    const urls: string[] = [];
    if (keys.directPath && keys.directPath.startsWith('/') && keys.directPath.length < 2048) {
        urls.push(`https://${MEDIA_HOST}${keys.directPath}`);
    }
    if (keys.url) {
        try {
            const parsed = new URL(keys.url);
            if (parsed.protocol === 'https:' && parsed.hostname.endsWith('.whatsapp.net')) {
                urls.push(parsed.toString());
            }
        } catch {
            /* nieczytelny adres pomijamy */
        }
    }
    return [...new Set(urls)];
}

export type FetchLike = (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Ściąga zaszyfrowany plik i go odszyfrowuje. Rzuca z opisem po polsku,
 * gdy żaden adres nie dał poprawnego pliku.
 */
export async function downloadAndDecrypt(
    keys: MediaKeys,
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<DownloadedMedia> {
    const urls = candidateUrls(keys);
    if (urls.length === 0) throw new Error('brak adresu pliku na serwerze mediów');

    const info = hkdfInfoFor(keys.type, keys.mimetype);
    let lastError = 'nieznany błąd';

    for (const url of urls) {
        try {
            const response = await fetchImpl(url, {
                headers: { Origin: 'https://web.whatsapp.com', Referer: 'https://web.whatsapp.com/' },
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            });
            if (!response.ok) {
                lastError = `serwer mediów odpowiedział ${response.status}`;
                continue;
            }
            const encrypted = Buffer.from(await response.arrayBuffer());

            if (keys.encFilehash) {
                const hash = crypto.createHash('sha256').update(encrypted).digest('base64');
                if (hash !== keys.encFilehash) {
                    lastError = 'skrót pobranego pliku nie zgadza się z wiadomością';
                    continue;
                }
            }

            const plain = decryptMedia(encrypted, keys.mediaKey, info);
            return {
                data: plain.toString('base64'),
                ...(keys.mimetype ? { mimetype: keys.mimetype } : {}),
                ...(keys.filename ? { filename: keys.filename } : {}),
                filesize: keys.size ?? plain.length,
            };
        } catch (err) {
            lastError = err instanceof Error ? err.message || err.name : String(err);
        }
    }
    throw new Error(lastError);
}
