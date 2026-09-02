// Rozpoznawanie kanałów WhatsAppa (WhatsApp Channels).
//
// Kanał to nadajnik, nie rozmowa: subskrybent nie ma tam nic do powiedzenia,
// a nadawca potrafi wrzucić kilkadziesiąt filmów dziennie. W archiwum
// wyglądało to jak zwykły czat - z pełnymi plikami na dysku - i po kilku
// subskrypcjach zajmowało więcej miejsca niż wszystkie prawdziwe rozmowy
// razem wzięte. Domyślnie więc kanały pomijamy; SAVE_CHANNELS=true wraca
// do starego zachowania.
//
// WhatsApp Web daje kanałom własną domenę identyfikatora: "<cyfry>@newsletter".
// To jedyny ślad, po którym da się je poznać bez pytania o model czatu -
// a pytać nie chcemy, bo serializacja modelu potrafi się wywrócić (patrz
// komentarze przy chatsForBackfill w src/archive.ts).

import type { WaMessage } from './types';

/** Domena identyfikatora kanału. WhatsApp bywa niekonsekwentny w przedrostku. */
const CHANNEL_ID = /@[a-z]*newsletter$/i;

/** Czy ten identyfikator należy do kanału, a nie do rozmowy ani grupy. */
export function isChannelId(id: string | null | undefined): boolean {
    return typeof id === 'string' && CHANNEL_ID.test(id);
}

/** Czy wiadomość przyszła z kanału. */
export function isChannelMessage(message: WaMessage | null): boolean {
    if (!message) return false;

    const remote = (message.id as { remote?: unknown } | undefined)?.remote;
    const serialized =
        typeof remote === 'string'
            ? remote
            : remote && typeof remote === 'object' && '_serialized' in remote
              ? String((remote as { _serialized?: unknown })._serialized ?? '')
              : null;

    return [message.from, message.to, message.author, serialized].some(isChannelId);
}
