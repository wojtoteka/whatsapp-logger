// Czytanie archiwum z dysku.
//
// Panel nie ma własnej bazy ani kopii danych - sięga wprost do folderu logs/,
// tego samego, do którego pisze logger. Wiadomości leżą w messages_XXXX.json
// (zamknięte partie) i w _state.json (partia w toku).
//
// Wszystko jest liczone na żądanie, więc panel zawsze pokazuje aktualny stan,
// bez odświeżania czy synchronizacji.

import fs from 'node:fs/promises';
import path from 'node:path';
import { cache } from 'react';
import type {
    ArchivedMessage,
    BatchFile,
    ChatStateFile,
    ChatSummary,
    MessagePage,
} from './typy';

/** Folder relacji - jego podfoldery to osobna kategoria, nie zwykłe rozmowy. */
export const STATUS_DIR = 'Statusy';

/** Foldery techniczne, które nie są czatem. */
const NOT_A_CHAT = new Set(['_avatars', '_tau']);

/**
 * Ścieżka do archiwum. Domyślnie logs/ obok panelu.
 *
 * turbopackIgnore wyłącza śledzenie plików przy budowaniu: folder z archiwum
 * jest wskazywany dopiero w czasie działania i nie ma go po co pakować
 * do wyniku kompilacji.
 */
export function logsDir(): string {
    const configured = process.env.LOGS_DIR;
    return configured
        ? path.resolve(/* turbopackIgnore: true */ process.cwd(), configured)
        : path.resolve(/* turbopackIgnore: true */ process.cwd(), '..', 'logs');
}

// -------------------------------------------------------------------------
//  Adresy
// -------------------------------------------------------------------------

/**
 * Folder w postaci nadającej się do adresu. "Statusy/Kontakt" ma ukośnik,
 * który rozbiłby ścieżkę w URL-u, więc zamieniamy go na dwa podkreślenia.
 */
export function toSlug(folder: string): string {
    return encodeURIComponent(folder.split('/').join('__'));
}

export function fromSlug(slug: string): string {
    return decodeURIComponent(slug).split('__').join('/');
}

/** Adres, spod którego panel serwuje plik z archiwum. */
export function fileUrl(archivePath: string | null): string | null {
    if (!archivePath) return null;
    const parts = archivePath.split('/').filter(Boolean).map(encodeURIComponent);
    return `/api/plik/${parts.join('/')}`;
}

/**
 * Ścieżka pliku widziana od folderu archiwum. Na dysku zapisywana jest
 * względem folderu czatu ("media/x.jpg", "../_avatars/y.jpg"), bo tak
 * działają odnośniki w plikach HTML.
 */
export function toArchivePath(folder: string, relative: string | null): string | null {
    if (!relative) return null;

    const normalized = path.posix.normalize(
        path.posix.join(folder, relative.split('\\').join('/')),
    );
    // Nic spoza archiwum nie ma prawa dostać adresu.
    return normalized.startsWith('..') ? null : normalized;
}

// -------------------------------------------------------------------------
//  Grupy
// -------------------------------------------------------------------------

/**
 * Foldery, w których siedzą grupy. Logger trzyma w _czaty.json powiązanie
 * identyfikatora WhatsAppa z folderem, a grupa ma identyfikator zakończony
 * na "@g.us" - to jedyne miejsce w archiwum, po którym da się ją poznać.
 */
const groupFolders = cache(async (): Promise<ReadonlySet<string>> => {
    const index = await readJson<Record<string, { safeName?: string }>>(
        path.join(logsDir(), '_czaty.json'),
    );

    const folders = new Set<string>();
    for (const [id, entry] of Object.entries(index ?? {})) {
        if (id.endsWith('@g.us') && entry?.safeName) folders.add(entry.safeName);
    }
    return folders;
});

/**
 * Czy zdjęcie należy do samej grupy, a nie do któregoś z uczestników. Wersje
 * leżą w _avatars/<identyfikator>/, gdzie "@" jest zamienione na "_", więc
 * grupę poznajemy po końcówce "_g.us" w nazwie folderu ze zdjęciami.
 */
function isGroupAvatar(archivePath: string | null): boolean {
    if (!archivePath) return false;
    const parts = archivePath.split('/');
    const at = parts.indexOf('_avatars');
    return at >= 0 && parts[at + 1]?.endsWith('_g.us') === true;
}

// -------------------------------------------------------------------------
//  Odczyt plików
// -------------------------------------------------------------------------

async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

async function listDirs(dir: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
        return [];
    }
}

/**
 * Źródła wiadomości czatu, od najstarszego. Zamknięte partie leżą w plikach
 * ponumerowanych rosnąco, a na końcu jest to, co czeka w _state.json.
 */
async function chatSources(folder: string): Promise<string[]> {
    const dir = path.join(logsDir(), ...folder.split('/'));

    let files: string[] = [];
    try {
        files = (await fs.readdir(dir))
            .filter((f) => /^messages_\d+\.json$/.test(f))
            .sort((a, b) => batchNumber(a) - batchNumber(b));
    } catch {
        return [];
    }
    return files;
}

function batchNumber(file: string): number {
    return Number.parseInt(/^messages_(\d+)\.json$/.exec(file)?.[1] ?? '0', 10);
}

async function readSource(folder: string, file: string): Promise<ArchivedMessage[]> {
    const full = path.join(logsDir(), ...folder.split('/'), file);
    const batch = await readJson<BatchFile>(full);
    return Array.isArray(batch?.messages) ? batch.messages : [];
}

// -------------------------------------------------------------------------
//  Lista czatów
// -------------------------------------------------------------------------

/** Wszystkie czaty w archiwum, osobno rozmowy i osobno relacje. */
async function listChatsUncached(): Promise<{ rozmowy: ChatSummary[]; relacje: ChatSummary[] }> {
    const root = logsDir();
    const folders: string[] = [];

    for (const name of await listDirs(root)) {
        if (NOT_A_CHAT.has(name)) continue;

        if (name === STATUS_DIR) {
            for (const author of await listDirs(path.join(root, name))) {
                folders.push(`${STATUS_DIR}/${author}`);
            }
            continue;
        }
        folders.push(name);
    }

    const summaries = await mapLimit(folders, 16, summarize);
    const known = summaries.filter((s): s is ChatSummary => s !== null);

    const byRecency = (a: ChatSummary, b: ChatSummary): number =>
        (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);

    return {
        rozmowy: known.filter((c) => !c.isStatus).sort(byRecency),
        relacje: known.filter((c) => c.isStatus).sort(byRecency),
    };
}

/** Layout i strona główna pytają o tę samą listę w jednym renderze. */
export const listChats = cache(listChatsUncached);

async function mapLimit<T, R>(
    values: readonly T[],
    limit: number,
    mapper: (value: T) => Promise<R>,
): Promise<R[]> {
    const result = new Array<R>(values.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= values.length) return;
            result[index] = await mapper(values[index]!);
        }
    });
    await Promise.all(workers);
    return result;
}

/**
 * Podsumowanie jednego czatu. Żeby nie czytać całego archiwum, sięgamy
 * tylko po stan i po najnowszą partię - tyle wystarcza na kafelek.
 */
async function summarize(folder: string): Promise<ChatSummary | null> {
    const dir = path.join(logsDir(), ...folder.split('/'));
    const state = await readJson<ChatStateFile>(path.join(dir, '_state.json'));
    const sources = await chatSources(folder);

    if (!state && sources.length === 0) return null;

    // Najnowsze wiadomości: to, co czeka w partii, a jak nic nie czeka -
    // ostatnia zamknięta partia.
    let newest = Array.isArray(state?.pendingMessages) ? state.pendingMessages : [];
    if (newest.length === 0 && sources.length > 0) {
        newest = await readSource(folder, sources[sources.length - 1]!);
    }

    const last = newest[newest.length - 1] ?? null;
    const isStatus = folder.startsWith(`${STATUS_DIR}/`);

    // Zdjęcie profilowe bierzemy z najnowszej wiadomości, która je ma -
    // dzięki temu na liście widać to aktualne.
    //
    // W grupie tak nie wolno: przy wiadomości leży zdjęcie jej nadawcy, więc
    // kafelek grupy pokazywałby ostatnią osobę, która coś napisała. Grupa ma
    // własne zdjęcie w _state.json - i tylko takie tu przyjmujemy, bo starsze
    // wersje loggera wpisywały w to pole zdjęcie uczestnika.
    const isGroup = (await groupFolders()).has(folder);
    let avatar: string | null = toArchivePath(folder, state?.avatar ?? null);

    if (isGroup) {
        if (!isGroupAvatar(avatar)) avatar = null;
    } else {
        for (let i = newest.length - 1; i >= 0; i--) {
            const candidate = newest[i]?.avatar;
            if (candidate) {
                avatar = toArchivePath(folder, candidate);
                break;
            }
        }
    }

    return {
        folder,
        slug: toSlug(folder),
        name: state?.chatName ?? folder.split('/').pop() ?? folder,
        isStatus,
        messageCount: state?.totalMessages ?? 0,
        lastMessageAt: last?.timestamp ?? null,
        avatar,
        preview: last ? previewOf(last) : null,
    };
}

/** Krótki podgląd ostatniej wiadomości na liście czatów. */
function previewOf(message: ArchivedMessage): string {
    const prefix = message.fromMe ? 'Ty: ' : '';
    if (message.body.trim()) return prefix + message.body.replace(/\s+/g, ' ').slice(0, 120);

    const labels: Record<string, string> = {
        image: 'zdjęcie',
        video: 'film',
        audio: 'nagranie',
        ptt: 'wiadomość głosowa',
        document: 'dokument',
        sticker: 'naklejka',
        location: 'lokalizacja',
        vcard: 'kontakt',
        multi_vcard: 'kontakty',
        poll_creation: 'ankieta',
    };
    return `${prefix}[${labels[message.type] ?? message.type}]`;
}

// -------------------------------------------------------------------------
//  Wiadomości czatu
// -------------------------------------------------------------------------

export interface PageOptions {
    /** Ile wiadomości na stronę. */
    limit: number;
    /** Ile pominąć, licząc od najnowszej. */
    offset?: number;
    /** Opaque cursor zwrócony przez poprzednią stronę. */
    cursor?: string | null;
}

/**
 * Wiadomości czatu od najnowszej. Idziemy od końca archiwum i czytamy tylko
 * tyle plików, ile trzeba na daną stronę - przy dużym archiwum reszta
 * w ogóle nie jest ruszana.
 */
export async function loadMessages(folder: string, options: PageOptions): Promise<MessagePage> {
    const dir = path.join(logsDir(), ...folder.split('/'));
    const state = await readJson<ChatStateFile>(path.join(dir, '_state.json'));
    const sources = await chatSources(folder);

    // Od najnowszego: najpierw partia w toku, potem zamknięte partie od tyłu.
    const chunks: Array<{ key: string; load: () => Promise<ArchivedMessage[]> }> = [
        {
            key: '_state',
            load: async () => (Array.isArray(state?.pendingMessages) ? state.pendingMessages : []),
        },
        ...[...sources].reverse().map((file) => ({ key: file, load: () => readSource(folder, file) })),
    ];

    const decoded = decodeCursor(options.cursor);
    let sourceIndex = decoded ? chunks.findIndex((chunk) => chunk.key === decoded.source) : 0;
    if (sourceIndex < 0) sourceIndex = 0;
    let cursorIndex = decoded?.index ?? -1;
    const collected: ArchivedMessage[] = [];
    let skipped = 0;
    let nextCursor: string | null = null;

    for (let chunkIndex = sourceIndex; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex]!;
        const messages = await chunk.load();
        const start = chunkIndex === sourceIndex && cursorIndex >= 0 ? cursorIndex : messages.length - 1;
        for (let i = start; i >= 0; i--) {
            if (skipped < (options.offset ?? 0)) {
                skipped++;
                continue;
            }
            collected.push(messages[i]!);
            if (collected.length >= options.limit) {
                if (i - 1 >= 0) {
                    nextCursor = encodeCursor({ source: chunk.key, index: i - 1 });
                } else if (chunkIndex + 1 < chunks.length) {
                    nextCursor = encodeCursor({ source: chunks[chunkIndex + 1]!.key, index: -1 });
                }
                break;
            }
        }
        if (collected.length >= options.limit) break;
    }

    return {
        messages: collected,
        // Licznik prowadzi logger w _state.json, więc nie ma po co
        // przeliczać całego archiwum przy każdym wejściu na stronę.
        total: state?.totalMessages ?? 0,
        hasOlder: nextCursor !== null,
        nextCursor,
    };
}

interface MessageCursor {
    source: string;
    index: number;
}

function encodeCursor(cursor: MessageCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null | undefined): MessageCursor | null {
    if (!value || value.length > 512) return null;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<MessageCursor>;
        const index = parsed.index;
        if (typeof parsed.source !== 'string' || typeof index !== 'number' || !Number.isInteger(index)) return null;
        if (parsed.source !== '_state' && !/^messages_\d+\.json$/.test(parsed.source)) return null;
        return { source: parsed.source, index: Math.max(-1, index) };
    } catch {
        return null;
    }
}

/** Nazwa i podstawowe dane czatu, bez czytania wiadomości. */
export async function loadChat(folder: string): Promise<ChatSummary | null> {
    return summarize(folder);
}
