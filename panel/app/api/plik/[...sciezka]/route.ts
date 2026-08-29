// Serwowanie plików z archiwum: zdjęć, filmów, nagrań i dokumentów.
//
// Archiwum leży poza folderem publicznym Next.js (i ma leżeć - to ten sam
// folder, do którego pisze logger), więc pliki wydaje ten endpoint.
//
// Dwie rzeczy są tu istotne: żadne żądanie nie może wyjść poza folder
// archiwum, i filmy muszą dać się przewijać, co wymaga obsługi zakresów.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { logsDir } from '@/lib/archiwum';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.3gp': 'video/3gpp',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

export async function GET(
    request: Request,
    { params }: { params: Promise<{ sciezka: string[] }> },
): Promise<Response> {
    const { sciezka } = await params;

    const root = path.resolve(logsDir());
    const target = path.resolve(root, ...sciezka.map((part) => decodeURIComponent(part)));

    // Klucz do bezpieczeństwa: po rozwiązaniu ścieżki plik musi nadal leżeć
    // wewnątrz archiwum. Inaczej "../../" wyprowadziłoby poza nie.
    const inside = target === root || target.startsWith(root + path.sep);
    if (!inside) {
        return new Response('Poza archiwum', { status: 403 });
    }

    let stat: fs.Stats;
    try {
        stat = await fsp.stat(target);
    } catch {
        return new Response('Nie ma takiego pliku', { status: 404 });
    }
    if (!stat.isFile()) {
        return new Response('To nie jest plik', { status: 404 });
    }

    const type = TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    const headers = new Headers({
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        // Nazwy plików niosą znacznik czasu, więc treść pod danym adresem
        // się nie zmienia - można ją trzymać w pamięci przeglądarki.
        'Cache-Control': 'private, max-age=3600',
    });

    const range = request.headers.get('range');
    const parsed = range ? parseRange(range, stat.size) : null;

    if (range && !parsed) {
        headers.set('Content-Range', `bytes */${stat.size}`);
        return new Response(null, { status: 416, headers });
    }

    if (parsed) {
        const { start, end } = parsed;
        headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        headers.set('Content-Length', String(end - start + 1));

        return new Response(toWebStream(fs.createReadStream(target, { start, end })), {
            status: 206,
            headers,
        });
    }

    headers.set('Content-Length', String(stat.size));
    return new Response(toWebStream(fs.createReadStream(target)), { status: 200, headers });
}

/** "bytes=0-1023" na liczby. Zwraca null, gdy zakres jest bez sensu. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;

    const [, rawStart, rawEnd] = match;
    let start: number;
    let end: number;

    if (rawStart === '') {
        // "bytes=-500" to ostatnie 500 bajtów.
        const length = Number.parseInt(rawEnd ?? '', 10);
        if (!Number.isFinite(length) || length <= 0) return null;
        start = Math.max(0, size - length);
        end = size - 1;
    } else {
        start = Number.parseInt(rawStart ?? '', 10);
        end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd ?? '', 10);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || start >= size || end < start) return null;

    return { start, end: Math.min(end, size - 1) };
}

function toWebStream(stream: fs.ReadStream): ReadableStream {
    return Readable.toWeb(stream) as unknown as ReadableStream;
}
