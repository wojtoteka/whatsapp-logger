// Czytanie archiwum bez uruchamiania WhatsAppa. Polecenie diagnostyczne
// sprawdza strukturę, JSON-y, duplikaty i odnośniki do plików.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArchivedMessage, BatchFile, ChatStateFile } from './types';

export type ArchiveIssueLevel = 'error' | 'warning';

export interface ArchiveIssue {
    level: ArchiveIssueLevel;
    file: string;
    message: string;
}

export interface ArchiveCheckResult {
    chats: number;
    states: number;
    batches: number;
    messages: number;
    errors: number;
    warnings: number;
    issues: ArchiveIssue[];
}

export async function checkArchive(logsDir: string): Promise<ArchiveCheckResult> {
    const result: ArchiveCheckResult = {
        chats: 0,
        states: 0,
        batches: 0,
        messages: 0,
        errors: 0,
        warnings: 0,
        issues: [],
    };
    const root = path.resolve(logsDir);

    if (!(await isDirectory(root))) {
        issue(result, 'error', '.', `folder archiwum nie istnieje: ${root}`);
        return result;
    }

    await checkChatIndex(root, result);
    const chatDirs = await findChatDirs(root);
    result.chats = chatDirs.length;
    for (const chatDir of chatDirs) await checkChatDir(root, chatDir, result);

    return result;
}

async function checkChatIndex(root: string, result: ArchiveCheckResult): Promise<void> {
    const file = path.join(root, '_czaty.json');
    if (!(await exists(file))) return;

    const parsed = await readJson(file, root, result);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        issue(result, 'error', relative(root, file), 'spis czatów nie jest obiektem');
        return;
    }

    for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const safeName = (value as { safeName?: unknown }).safeName;
        if (typeof safeName !== 'string' || safeName.length === 0) continue;

        const target = path.resolve(root, safeName);
        if (!inside(root, target)) {
            issue(result, 'error', relative(root, file), `wpis wychodzi poza archiwum: ${safeName}`);
        } else if (!(await isDirectory(target))) {
            issue(result, 'warning', relative(root, file), `wpis wskazuje brakujący folder: ${safeName}`);
        }
    }
}

async function findChatDirs(root: string): Promise<string[]> {
    const dirs: string[] = [];
    for (const entry of await dirents(root)) {
        if (!entry.isDirectory() || entry.name === '_avatars' || entry.name === '_tau') continue;
        const full = path.join(root, entry.name);

        if (entry.name !== 'Statusy') {
            dirs.push(full);
            continue;
        }
        for (const author of await dirents(full)) {
            if (author.isDirectory()) dirs.push(path.join(full, author.name));
        }
    }
    return dirs;
}

async function checkChatDir(
    root: string,
    chatDir: string,
    result: ArchiveCheckResult,
): Promise<void> {
    const names = (await dirents(chatDir)).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const statePath = path.join(chatDir, '_state.json');
    const hasState = await exists(statePath);
    const state = hasState ? await readJson(statePath, root, result) : null;
    const allIds = new Set<string>();
    let presentMessages = 0;

    if (state !== null) {
        result.states++;
        if (!isState(state)) {
            issue(result, 'error', relative(root, statePath), 'stan nie ma wymaganych pól');
        } else {
            const pending = state.pendingMessages;
            presentMessages += pending.length;
            result.messages += pending.length;
            await checkMessages(root, chatDir, statePath, pending, allIds, result);

            if (Array.isArray(state.seenIds) && new Set(state.seenIds).size !== state.seenIds.length) {
                issue(result, 'warning', relative(root, statePath), 'seenIds zawiera powtórzenia');
            }
        }
    } else if (!hasState) {
        issue(result, 'warning', relative(root, chatDir), 'brakuje _state.json');
    }

    const jsonBatches = names.filter((name) => /^messages_\d+\.json$/.test(name)).sort();
    const htmlBatches = new Set(names.filter((name) => /^messages_\d+\.html$/.test(name)));

    for (const jsonName of jsonBatches) {
        const jsonPath = path.join(chatDir, jsonName);
        const htmlName = jsonName.replace(/\.json$/, '.html');
        if (!htmlBatches.delete(htmlName)) {
            issue(result, 'warning', relative(root, jsonPath), `brakuje pary ${htmlName}`);
        }

        const parsed = await readJson(jsonPath, root, result);
        if (!isBatch(parsed)) {
            if (parsed !== null) {
                issue(result, 'error', relative(root, jsonPath), 'partia nie ma tablicy messages');
            }
            continue;
        }
        result.batches++;
        result.messages += parsed.messages.length;
        presentMessages += parsed.messages.length;
        await checkMessages(root, chatDir, jsonPath, parsed.messages, allIds, result);
    }

    for (const htmlName of htmlBatches) {
        issue(
            result,
            'warning',
            relative(root, path.join(chatDir, htmlName)),
            `brakuje danych ${htmlName.replace(/\.html$/, '.json')}`,
        );
    }

    if (isState(state) && state.totalMessages < presentMessages) {
        issue(
            result,
            'error',
            relative(root, statePath),
            `totalMessages=${state.totalMessages} jest mniejsze od ${presentMessages} wiadomości obecnych na dysku`,
        );
    }
}

async function checkMessages(
    root: string,
    chatDir: string,
    source: string,
    messages: readonly unknown[],
    allIds: Set<string>,
    result: ArchiveCheckResult,
): Promise<void> {
    for (const rawMessage of messages) {
        if (!rawMessage || typeof rawMessage !== 'object') {
            issue(result, 'error', relative(root, source), 'wiadomość nie jest obiektem');
            continue;
        }
        const message = rawMessage as Partial<ArchivedMessage>;
        if (typeof message.id !== 'string' || message.id.length === 0) {
            issue(result, 'error', relative(root, source), 'wiadomość bez identyfikatora');
            continue;
        }
        if (allIds.has(message.id)) {
            issue(result, 'error', relative(root, source), `zduplikowane ID wiadomości: ${message.id}`);
        } else {
            allIds.add(message.id);
        }
        if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) {
            issue(result, 'warning', relative(root, source), `wiadomość ${message.id} ma błędny czas`);
        }

        for (const [label, storedPath] of [
            ['media', message.mediaPath],
            ['avatar', message.avatar],
        ] as const) {
            if (!storedPath) continue;
            if (typeof storedPath !== 'string') {
                issue(
                    result,
                    'warning',
                    relative(root, source),
                    `${label} wiadomości ${message.id} nie jest ścieżką tekstową`,
                );
                continue;
            }
            const target = path.resolve(chatDir, storedPath);
            if (!inside(root, target)) {
                issue(
                    result,
                    'error',
                    relative(root, source),
                    `${label} wiadomości ${message.id} wychodzi poza archiwum: ${storedPath}`,
                );
            } else if (!(await exists(target))) {
                issue(
                    result,
                    'warning',
                    relative(root, source),
                    `brak pliku ${label} wiadomości ${message.id}: ${storedPath}`,
                );
            }
        }
    }
}

function isState(value: unknown): value is ChatStateFile {
    if (!value || typeof value !== 'object') return false;
    const state = value as Partial<ChatStateFile>;
    return (
        typeof state.chatName === 'string' &&
        typeof state.batchNum === 'number' &&
        typeof state.totalMessages === 'number' &&
        Array.isArray(state.pendingMessages)
    );
}

function isBatch(value: unknown): value is BatchFile {
    return Boolean(value && typeof value === 'object' && Array.isArray((value as BatchFile).messages));
}

async function readJson(file: string, root: string, result: ArchiveCheckResult): Promise<unknown> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        issue(result, 'error', relative(root, file), `nie można odczytać JSON-a: ${why}`);
        return null;
    }
}

function issue(
    result: ArchiveCheckResult,
    level: ArchiveIssueLevel,
    file: string,
    message: string,
): void {
    result.issues.push({ level, file, message });
    if (level === 'error') result.errors++;
    else result.warnings++;
}

function inside(root: string, target: string): boolean {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function relative(root: string, file: string): string {
    return path.relative(root, file).replace(/\\/g, '/') || '.';
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

async function isDirectory(dir: string): Promise<boolean> {
    try {
        return (await fs.stat(dir)).isDirectory();
    } catch {
        return false;
    }
}

async function dirents(dir: string): Promise<import('node:fs').Dirent[]> {
    try {
        return await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}
