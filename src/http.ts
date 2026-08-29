// Pobranie pliku spod adresu HTTP(S) do pamięci.
//
// Używane wyłącznie do zdjęć profilowych, których WhatsApp nie oddaje
// przez API biblioteki, tylko przez zwykły adres. Limit rozmiaru jest po to,
// żeby nieoczekiwanie duża odpowiedź nie wjechała nam w całości do pamięci.

import http from 'node:http';
import https from 'node:https';

const DEFAULT_TIMEOUT_MS = 15000;

export interface FetchOptions {
    maxBytes?: number;
    timeoutMs?: number;
}

export function fetchBuffer(url: string, options: FetchOptions = {}): Promise<Buffer> {
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        const transport = url.startsWith('http://') ? http : https;

        const request = transport.get(url, (response) => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
                response.resume();
                reject(new Error(`HTTP ${status}`));
                return;
            }

            const chunks: Buffer[] = [];
            let size = 0;

            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxBytes) {
                    request.destroy();
                    reject(new Error(`plik ponad limit ${Math.round(maxBytes / 1024 / 1024)} MB`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                resolve(Buffer.concat(chunks));
            });
            response.on('error', reject);
        });

        request.on('error', reject);
        request.setTimeout(timeoutMs, () => {
            request.destroy();
            reject(new Error('przekroczony czas oczekiwania'));
        });
    });
}
