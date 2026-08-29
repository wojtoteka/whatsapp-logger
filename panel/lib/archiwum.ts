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
const NOT_A_CHAT = new Set(['_avatars']);

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

// ─────────────────────────────────────────────────────────────────────────
//  Adresy
// ─────────────────────────────────────────────────────────────────────────

/**
 * Folder w postaci nadającej się do adresu. "Statusy/Dawid" ma ukośnik,
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

// ─────────────────────────────────────────────────────────────────────────
//  Odczyt plików
// ─────────────────────────────────────────────────────────────────────────

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
            .sort();
    } catch {
        return [];
    }
    return files;
}

async function readSource(folder: string, file: string): Promise<ArchivedMessage[]> {
    const full = path.join(logsDir(), ...folder.split('/'), file);
    const batch = await readJson<BatchFile>(full);
    return Array.isArray(batch?.messages) ? batch.messages : [];
}

// ─────────────────────────────────────────────────────────────────────────
//  Lista czatów
// ─────────────────────────────────────────────────────────────────────────

/** Wszystkie czaty w archiwum, osobno rozmowy i osobno relacje. */
export async function listChats(): Promise<{ rozmowy: ChatSummary[]; relacje: ChatSummary[] }> {
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

    const summaries = await Promise.all(folders.map((folder) => summarize(folder)));
    const known = summaries.filter((s): s is ChatSummary => s !== null);

    const byRecency = (a: ChatSummary, b: ChatSummary): number =>
        (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);

    return {
        rozmowy: known.filter((c) => !c.isStatus).sort(byRecency),
        relacje: known.filter((c) => c.isStatus).sort(byRecency),
    };
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
    let avatar: string | null = null;
    for (let i = newest.length - 1; i >= 0; i--) {
        const candidate = newest[i]?.avatar;
        if (candidate) {
            avatar = toArchivePath(folder, candidate);
            break;
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

// ─────────────────────────────────────────────────────────────────────────
//  Wiadomości czatu
// ─────────────────────────────────────────────────────────────────────────

export interface PageOptions {
    /** Ile wiadomości na stronę. */
    limit: number;
    /** Ile pominąć, licząc od najnowszej. */
    offset: number;
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
    const chunks: Array<() => Promise<ArchivedMessage[]>> = [
        async () => (Array.isArray(state?.pendingMessages) ? state.pendingMessages : []),
        ...[...sources].reverse().map((file) => () => readSource(folder, file)),
    ];

    // Bierzemy jedną wiadomość ponad limit. Jeśli się doczytała, to znaczy,
    // że jest co pokazywać dalej - i nie musimy w tym celu liczyć całości.
    const wanted = options.limit + 1;
    const collected: ArchivedMessage[] = [];
    let skipped = 0;

    for (const load of chunks) {
        if (collected.length >= wanted) break;

        const messages = await load();
        for (let i = messages.length - 1; i >= 0; i--) {
            if (skipped < options.offset) {
                skipped++;
                continue;
            }
            collected.push(messages[i]!);
            if (collected.length >= wanted) break;
        }
    }

    const hasOlder = collected.length > options.limit;

    return {
        messages: collected.slice(0, options.limit),
        // Licznik prowadzi logger w _state.json, więc nie ma po co
        // przeliczać całego archiwum przy każdym wejściu na stronę.
        total: state?.totalMessages ?? 0,
        hasOlder,
    };
}

/** Nazwa i podstawowe dane czatu, bez czytania wiadomości. */
export async function loadChat(folder: string): Promise<ChatSummary | null> {
    return summarize(folder);
}
