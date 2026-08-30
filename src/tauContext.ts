// Odczyt kontekstu dla ?tau. Ten moduł nigdy nie pobiera multimediów i nie
// zapisuje kopii rozmowy. Czyta tylko ostatnie potrzebne partie JSON.

import path from 'node:path';
import type { ArchivedMessage, BatchFile, ChatIndexEntry, ChatStateFile } from './types';
import { listDirents, readJson } from './util';

export interface TauContextMessage {
    author: string;
    timestamp: number;
    text: string;
    deleted: boolean;
}

export interface TauConversation {
    ids: string[];
    name: string;
    folder: string;
}

export type ConversationMatch =
    | { status: 'found'; conversation: TauConversation }
    | { status: 'ambiguous'; conversations: TauConversation[] }
    | { status: 'not_found' };

export type TargetedTauCommand =
    | { status: 'found'; conversation: TauConversation; question: string }
    | { status: 'ambiguous'; conversations: TauConversation[] }
    | { status: 'invalid'; message: string };

export function parseTauCommand(body: string): string | null {
    const match = /^\?tau(?:\s+([\s\S]*))?$/i.exec(body.trim());
    if (!match) return null;
    return (match[1] ?? '').trim();
}

/**
 * Ostatnie wiadomości tekstowe, od najstarszej do najnowszej. Polecenia ?tau
 * oraz odpowiedzi techniczne [TAU] nie wracają do następnego requestu.
 */
export async function loadTauContext(
    logsDir: string,
    folder: string,
    options: {
        maxMessages: number;
        maxChars: number;
        /** Bieżąca partia z procesu loggera, świeższa niż zapisany _state.json. */
        pendingMessages?: readonly ArchivedMessage[] | null;
    },
): Promise<TauContextMessage[]> {
    const chatDir = safeChatDir(logsDir, folder);
    const state = await readJson<ChatStateFile>(path.join(chatDir, '_state.json'));
    if (!state) throw new Error('Nie znaleziono lokalnego archiwum tej rozmowy.');

    const files = (await listDirents(chatDir))
        .filter((entry) => entry.isFile() && /^messages_\d+\.json$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => batchNumber(b) - batchNumber(a));

    const result: TauContextMessage[] = [];
    let usedChars = 0;

    const takeChunk = (messages: readonly ArchivedMessage[]): boolean => {
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index]!;
            if (!isTauText(message)) continue;

            const remaining = options.maxChars - usedChars;
            if (remaining <= 0 || result.length >= options.maxMessages) return false;

            let text = message.body.trim();
            if (text.length > remaining) {
                text = `[początek pominięty] ${text.slice(-(Math.max(0, remaining - 21)))}`;
            }
            if (!text) continue;

            result.push({
                author: message.fromMe ? 'Właściciel' : message.from || 'Rozmówca',
                timestamp: message.timestamp,
                text,
                deleted: message.isDeleted === true,
            });
            usedChars += text.length;
        }
        return result.length < options.maxMessages && usedChars < options.maxChars;
    };

    const pending = options.pendingMessages ??
        (Array.isArray(state.pendingMessages) ? state.pendingMessages : []);
    if (!takeChunk(pending)) {
        return result.reverse();
    }

    for (const file of files) {
        const batch = await readJson<BatchFile>(path.join(chatDir, file));
        if (batch && !takeChunk(Array.isArray(batch.messages) ? batch.messages : [])) break;
    }

    return result.reverse();
}

export async function listTauConversations(logsDir: string): Promise<TauConversation[]> {
    const index = await readJson<Record<string, ChatIndexEntry>>(path.join(logsDir, '_czaty.json'));
    const byFolder = new Map<string, TauConversation>();

    for (const [id, entry] of Object.entries(index ?? {})) {
        if (!entry?.safeName || entry.safeName.startsWith('Statusy/')) continue;
        const known = byFolder.get(entry.safeName);
        if (known) {
            if (!known.ids.includes(id)) known.ids.push(id);
            continue;
        }
        byFolder.set(entry.safeName, {
            ids: [id],
            name: entry.name || entry.safeName,
            folder: entry.safeName,
        });
    }

    return [...byFolder.values()].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
}

export async function conversationForChatId(
    logsDir: string,
    chatId: string,
): Promise<TauConversation | null> {
    const conversations = await listTauConversations(logsDir);
    const exact = conversations.find((item) => item.ids.includes(chatId));
    if (exact) return exact;

    const number = normalizePhone(chatId);
    if (!number) return null;
    return conversations.find((item) => item.ids.some((id) => normalizePhone(id) === number)) ?? null;
}

/** Priorytet: numer, nazwa dokładna, wielkość liter, normalizacja, fuzzy. */
export function findConversation(
    conversations: readonly TauConversation[],
    query: string,
): ConversationMatch {
    const trimmed = query.trim();
    if (!trimmed) return { status: 'not_found' };

    const phone = normalizePhone(trimmed);
    if (phone.length >= 7) {
        const matches = conversations.filter((item) =>
            item.ids.some((id) => normalizePhone(id) === phone),
        );
        return uniqueMatch(matches);
    }

    const exact = conversations.filter((item) => item.name.trim() === trimmed);
    if (exact.length > 0) return uniqueMatch(exact);

    const lower = trimmed.toLocaleLowerCase('pl');
    const sameCaseInsensitive = conversations.filter(
        (item) => item.name.trim().toLocaleLowerCase('pl') === lower,
    );
    if (sameCaseInsensitive.length > 0) return uniqueMatch(sameCaseInsensitive);

    const normalized = normalizeName(trimmed);
    const sameNormalized = conversations.filter((item) => normalizeName(item.name) === normalized);
    if (sameNormalized.length > 0) return uniqueMatch(sameNormalized);

    const scored = conversations
        .map((conversation) => ({
            conversation,
            score: similarity(normalized, normalizeName(conversation.name)),
        }))
        .filter((item) => item.score >= 0.72)
        .sort((a, b) => b.score - a.score);

    const first = scored[0];
    if (!first) return { status: 'not_found' };
    const close = scored.filter((item) => first.score - item.score < 0.08);
    if (close.length > 1) {
        return {
            status: 'ambiguous',
            conversations: close.slice(0, 5).map((item) => item.conversation),
        };
    }
    return { status: 'found', conversation: first.conversation };
}

/**
 * Rozdziela "Natalia pytanie" bez zgadywania przez AI. Dopasowanie nazwy
 * musi objąć początek tekstu, a po niej musi zostać niepuste pytanie.
 */
export function resolveTargetedTauCommand(
    input: string,
    conversations: readonly TauConversation[],
): TargetedTauCommand {
    const trimmed = input.trim();
    if (!trimmed) {
        return { status: 'invalid', message: 'Podaj kontakt albo numer oraz pytanie.' };
    }

    const phoneMatch = /^(\+?\d[\d\s().-]{5,}\d)\s+([\s\S]+)$/.exec(trimmed);
    if (phoneMatch) {
        return withQuestion(findConversation(conversations, phoneMatch[1]!), phoneMatch[2]!);
    }

    const normalizedInput = normalizeName(trimmed);
    const exactPrefixes = conversations
        .map((conversation) => ({ conversation, target: normalizeName(conversation.name) }))
        .filter(({ target }) => target.length > 0 && normalizedInput.startsWith(`${target} `))
        .sort((a, b) => b.target.length - a.target.length);
    const longest = exactPrefixes[0];
    if (longest) {
        const sameLength = exactPrefixes.filter((item) => item.target.length === longest.target.length);
        if (sameLength.length > 1) {
            return {
                status: 'ambiguous',
                conversations: sameLength.slice(0, 5).map((item) => item.conversation),
            };
        }
        const question = questionAfterNormalizedPrefix(trimmed, longest.target);
        if (question) return { status: 'found', conversation: longest.conversation, question };
    }

    const words = trimmed.split(/\s+/);
    const candidates: Array<{
        match: ConversationMatch;
        question: string;
        score: number;
    }> = [];
    for (let count = 1; count <= Math.min(5, words.length - 1); count++) {
        const target = words.slice(0, count).join(' ');
        const match = findConversation(conversations, target);
        if (match.status === 'not_found') continue;
        const question = words.slice(count).join(' ').trim();
        if (!question) continue;
        const bestName =
            match.status === 'found' ? match.conversation.name : match.conversations[0]?.name ?? '';
        candidates.push({
            match,
            question,
            score: similarity(normalizeName(target), normalizeName(bestName)),
        });
    }

    candidates.sort((a, b) => b.score - a.score || b.question.length - a.question.length);
    const best = candidates[0];
    if (!best) return { status: 'invalid', message: 'Nie znaleziono takiej rozmowy.' };
    return withQuestion(best.match, best.question);
}

export function normalizeName(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[łŁ]/g, (letter) => (letter === 'Ł' ? 'L' : 'l'))
        .toLocaleLowerCase('pl')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

export function normalizePhone(value: string): string {
    return value.replace(/@[^\s]+$/i, '').replace(/\D/g, '');
}

function isTauText(message: ArchivedMessage): boolean {
    if (message.type !== 'chat') return false;
    const body = message.body.trim();
    if (!body) return false;
    return !/^\?tau(?:\s|$)/i.test(body) && !/^\[TAU\](?:\s|$)/i.test(body);
}

function batchNumber(file: string): number {
    return Number.parseInt(/^messages_(\d+)\.json$/.exec(file)?.[1] ?? '0', 10);
}

function safeChatDir(logsDir: string, folder: string): string {
    const root = path.resolve(logsDir);
    const target = path.resolve(root, ...folder.replace(/\\/g, '/').split('/'));
    const relative = path.relative(root, target);
    if (!folder || path.isAbsolute(folder) || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Nieprawidłowy folder rozmowy.');
    }
    return target;
}

function uniqueMatch(matches: readonly TauConversation[]): ConversationMatch {
    if (matches.length === 0) return { status: 'not_found' };
    if (matches.length === 1) return { status: 'found', conversation: matches[0]! };
    return { status: 'ambiguous', conversations: [...matches].slice(0, 5) };
}

function withQuestion(match: ConversationMatch, question: string): TargetedTauCommand {
    const cleanQuestion = question.trim();
    if (!cleanQuestion) return { status: 'invalid', message: 'Pytanie nie może być puste.' };
    if (match.status === 'found') {
        return { status: 'found', conversation: match.conversation, question: cleanQuestion };
    }
    if (match.status === 'ambiguous') {
        return { status: 'ambiguous', conversations: match.conversations };
    }
    return { status: 'invalid', message: 'Nie znaleziono takiej rozmowy.' };
}

function questionAfterNormalizedPrefix(original: string, target: string): string | null {
    const words = original.split(/\s+/);
    for (let count = 1; count < words.length; count++) {
        if (normalizeName(words.slice(0, count).join(' ')) === target) {
            return words.slice(count).join(' ').trim() || null;
        }
    }
    return null;
}

function similarity(left: string, right: string): number {
    if (!left || !right) return 0;
    if (left === right) return 1;
    const distance = levenshtein(left, right);
    return 1 - distance / Math.max(left.length, right.length);
}

function levenshtein(left: string, right: string): number {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
        const current = [i];
        for (let j = 1; j <= right.length; j++) {
            current[j] = Math.min(
                (current[j - 1] ?? 0) + 1,
                (previous[j] ?? 0) + 1,
                (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return previous[right.length] ?? right.length;
}
