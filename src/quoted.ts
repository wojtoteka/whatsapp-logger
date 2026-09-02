// Odpowiedzi na wiadomości - czytane wprost z modelu w przeglądarce.
//
// Message.getQuotedMessage() z whatsapp-web.js przepuszcza cytowaną wiadomość
// przez WWebJS.getMessageModel(), czyli przez serialize() - a to w tym wydaniu
// WhatsApp Weba jest dokładnie ta droga, która kończy się zminifikowanym
// "r: r" (ten sam powód, dla którego lista czatów, historia i pliki są czytane
// wprost ze Store - patrz src/waClient.ts i src/media.ts).
//
// Skutek był cichy i dlatego kosztowny: quotedInfo() łapało wyjątek, oddawało
// null i w archiwum nie zostawał po odpowiedzi żaden ślad. W panelu widać było
// same luźne wiadomości, bez informacji, do czego się odnoszą.
//
// Tutaj nie ma żadnej serializacji: bierzemy z modelu cztery pola, każde
// osłonięte, bo pola modeli WhatsApp Weba bywają getterami, które rzucają.

import { messageHash, messageKey } from './identity';
import { ensurePageAccess, PAGE_HELPER } from './pageStore';
import type { WaMessage } from './types';

/** Cytowana wiadomość w postaci, jaką da się odczytać bez serializacji. */
export interface RawQuoted {
    /** Identyfikator cytowanej wiadomości, gdy da się go złożyć. */
    id: string | null;
    /** Identyfikator autora cytowanej wiadomości. */
    author: string | null;
    /** null = nie wiadomo; wtedy autora ustala dopiero strona Node. */
    fromMe: boolean | null;
    body: string | null;
    type: string | null;
}

/**
 * Czy w surowych danych wiadomości jest ślad odpowiedzi.
 *
 * Sprawdzane po stronie Node, bez dotykania przeglądarki - inaczej każda
 * zwykła wiadomość kosztowałaby jedno wywołanie page.evaluate() tylko po to,
 * żeby usłyszeć "nie, to nie jest odpowiedź".
 *
 * Nie wystarczy samo hasQuotedMsg: biblioteka wylicza je z pola quotedMsg,
 * którego serialize() w tym wydaniu WhatsApp Weba już nie oddaje. Zostaje
 * za to quotedStanzaID - identyfikator wiadomości, na którą ktoś odpowiedział.
 */
export function hasQuotedHint(message: WaMessage | null): boolean {
    if (!message) return false;
    if (message.hasQuotedMsg === true) return true;

    const data = message._data;
    if (!data) return false;

    return ['quotedMsg', 'quotedStanzaID', 'quotedParticipant', 'quotedRemoteJid'].some(
        (key) => data[key] != null && data[key] !== '',
    );
}

/**
 * Cytowana wiadomość odczytana z kolekcji Store, z pominięciem
 * Message.getQuotedMessage(). Zwraca null, gdy odpowiedzi nie ma albo gdy
 * strona nie jest w stanie nic powiedzieć.
 */
export async function readQuotedFromStore(message: WaMessage): Promise<RawQuoted | null> {
    const wanted = [messageKey(message), messageHash(message)].filter(
        (value): value is string => Boolean(value),
    );
    if (wanted.length === 0) return null;

    const page = message.client?.pupPage;
    if (!page) return null;

    // Kolekcje potrafią zniknąć razem z przeładowaną stroną - patrz pageStore.
    const access = await ensurePageAccess(message.client);
    if (!access.ready) return null;

    try {
        return await page.evaluate(
            (wantedIds: string[], helperName: string): RawQuoted | null => {
                /* eslint-disable @typescript-eslint/no-explicit-any */
                const win = globalThis as any;

                /** Odczyt z modelu, który nie ma prawa przewrócić całej strony. */
                const safe = <T>(read: () => T, fallback: T): T => {
                    try {
                        return read();
                    } catch {
                        return fallback;
                    }
                };

                const helper = safe(() => win[helperName], null);
                const Store = safe(() => helper?.store?.(), null) ?? safe(() => win.Store, null);
                if (!Store?.Msg) return null;

                /** Identyfikator w postaci napisu, niezależnie od tego, czym jest. */
                const asId = (value: any): string | null =>
                    safe(() => {
                        if (typeof value === 'string') return value || null;
                        const serialized = value?._serialized;
                        return typeof serialized === 'string' && serialized ? serialized : null;
                    }, null);

                const models = (value: any): any[] =>
                    safe(() => {
                        if (!value) return [];
                        if (Array.isArray(value)) return value;
                        if (typeof value.getModelsArray === 'function') return value.getModelsArray();
                        if (Array.isArray(value.models)) return value.models;
                        return [];
                    }, []);

                let msg: any = null;
                for (const wantedId of wantedIds) {
                    msg = safe(() => Store.Msg?.get?.(wantedId) ?? null, null);
                    if (msg) break;
                }
                if (!msg) return null;

                // Cztery drogi do cytowanej wiadomości, od najtańszej. Niżej
                // jeszcze dwie, bo wymagają quotedStanzaID.
                //
                // 1. Pole quotedMsg - gotowy obiekt z treścią, gdy WhatsApp
                //    dołączył go do wiadomości.
                // 2. Moduł WhatsAppa, z którego korzysta sama biblioteka -
                //    tyle że tutaj bez przepuszczania wyniku przez serialize().
                let quoted: any = safe(() => msg.quotedMsg, null);
                if (!quoted) {
                    quoted = safe(() => Store.QuotedMsg?.getQuotedMsgObj?.(msg) ?? null, null);
                }

                const stanzaId =
                    asId(safe(() => msg.quotedStanzaID, null)) ??
                    asId(safe(() => msg.quotedMsgKey?.id, null));

                // Klucz wiadomości w WhatsApp Webie składa się z gotowych
                // części: kierunku, rozmowy, identyfikatora i - w grupie -
                // uczestnika. Złożenie go i jedno get() jest tańsze niż
                // przejście całej kolekcji, a przy nadrabianiu historii ta
                // kolekcja liczy dziesiątki tysięcy wiadomości.
                const remote = asId(safe(() => msg.id?.remote, null));
                const participant = asId(safe(() => msg.quotedParticipant, null));

                if (!quoted && stanzaId && remote) {
                    for (const fromMe of ['false', 'true']) {
                        const keys = [`${fromMe}_${remote}_${stanzaId}`];
                        if (participant) keys.push(`${fromMe}_${remote}_${stanzaId}_${participant}`);

                        for (const key of keys) {
                            quoted = safe(() => Store.Msg?.get?.(key) ?? null, null);
                            if (quoted) break;
                        }
                        if (quoted) break;
                    }
                }

                // Ostatnia droga: przejście kolekcji. Kosztowna, więc dopiero
                // wtedy, gdy złożony klucz nie trafił.
                if (!quoted && stanzaId) {
                    quoted =
                        models(Store.Msg).find(
                            (candidate) => asId(safe(() => candidate?.id?.id, null)) === stanzaId,
                        ) ?? null;
                }
                if (!quoted && !stanzaId) return null;

                const author =
                    asId(safe(() => quoted?.author, null)) ??
                    asId(safe(() => quoted?.from, null)) ??
                    participant ??
                    asId(safe(() => msg.quotedRemoteJid, null));

                const fromMe = safe(() => {
                    const value = quoted?.id?.fromMe ?? quoted?.fromMe;
                    return typeof value === 'boolean' ? value : null;
                }, null);

                const body = safe(() => {
                    const value = quoted?.body ?? quoted?.caption ?? quoted?.text;
                    return typeof value === 'string' && value.length > 0 ? value : null;
                }, null);

                const type = safe(() => {
                    const value = quoted?.type;
                    return typeof value === 'string' && value.length > 0 ? value : null;
                }, null);

                // Sam identyfikator bez treści to wciąż informacja: wiadomo,
                // że to odpowiedź, tylko cytatu już nie ma w pamięci strony.
                return {
                    id: asId(safe(() => quoted?.id, null)) ?? stanzaId,
                    author,
                    fromMe,
                    body,
                    type,
                };
                /* eslint-enable @typescript-eslint/no-explicit-any */
            },
            wanted,
            PAGE_HELPER,
        );
    } catch {
        // Strona mogła się przeładować w trakcie. Odpowiedź bez cytatu jest
        // lepsza niż przewrócony zapis wiadomości.
        return null;
    }
}
