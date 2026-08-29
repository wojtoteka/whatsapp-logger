// Rozpoznawanie relacji (statusów).
//
// WhatsApp przysyła je tą samą drogą co zwykłe wiadomości, tyle że
// z rozmówcą "status@broadcast". Bez tego rozpoznania cudze relacje
// wpadałyby do folderu rozmowy z daną osobą, wymieszane z jej wiadomościami.
//
// Relacje trzymamy w logs/Statusy/<autor>, a klucz czatu dostaje przedrostek
// "status:", żeby nie zderzył się ze zwykłą rozmową tej samej osoby.

import type { WaMessage } from './types';

/** Folder, w którym lądują wszystkie relacje. */
export const STATUS_DIR = 'Statusy';

/** Przedrostek klucza czatu z relacjami. */
const STATUS_PREFIX = 'status:';

/** Ile identyfikatorów relacji trzymamy na czat, żeby nie zapisać ich dwa razy. */
export const STATUS_SEEN_LIMIT = 500;

/** Czy to relacja, a nie zwykła wiadomość. */
export function isStatusMessage(message: WaMessage | null): boolean {
    if (!message) return false;
    if (message.isStatus || message.isStatusV3 || message._data?.isStatusV3) return true;

    const remote = (message.id as { remote?: unknown } | undefined)?.remote;
    const serialized =
        typeof remote === 'string'
            ? remote
            : remote && typeof remote === 'object' && '_serialized' in remote
              ? String((remote as { _serialized?: unknown })._serialized ?? '')
              : '';

    return (
        serialized === 'status@broadcast' ||
        message.from === 'status@broadcast' ||
        message.to === 'status@broadcast'
    );
}

/** Identyfikator autora relacji. Własne poznajemy po fromMe. */
export function statusAuthorId(message: WaMessage | null): string | null {
    if (!message) return null;
    if (message.fromMe) return 'me';

    const id = message.author ?? message.from;
    if (typeof id !== 'string' || id.length === 0) return null;
    return id === 'status@broadcast' ? null : id;
}

/** Klucz czatu z relacjami danej osoby. */
export function statusChatId(authorId: string): string {
    return `${STATUS_PREFIX}${authorId}`;
}

export function isStatusChat(chatId: string): boolean {
    return chatId.startsWith(STATUS_PREFIX);
}

/** Identyfikator bez przedrostka relacji - taki zna WhatsApp. */
export function bareId(chatId: string): string {
    return isStatusChat(chatId) ? chatId.slice(STATUS_PREFIX.length) : chatId;
}
