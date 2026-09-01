// Kto to jest i pod jaką nazwą prowadzimy jego czat.
//
// To tutaj rozwiązywał się główny problem poprzedniej wersji: WhatsApp
// przysyła dziś identyfikatory w postaci "<cyfry>@lid" zamiast numeru
// telefonu, a getChat() na takim identyfikatorze wywraca się w środku
// przeglądarki. Efekt był taki, że foldery nazywały się gołymi cyframi.
//
// Zasada jest prosta: nazwa taka, jak masz człowieka zapisanego w telefonie,
// a jak nie masz - jego nazwa profilu, potem numer telefonu, a cyfry
// z identyfikatora dopiero na samym końcu.

import { log } from './log';
import { NameTier } from './types';
import { readChatSubject } from './waClient';
import type { ChatIdentity, WaClient, WaContact, WaMessage } from './types';
import { phoneDigits } from './util';

/** Jak długo wierzymy pustej odpowiedzi o kontakcie, zanim spytamy znowu. */
const CONTACT_RETRY_MS = 5 * 60 * 1000;

/** Odstęp między próbami dociągnięcia lepszej nazwy dla znanego już czatu. */
export const NAME_RETRY_MS = 5 * 60 * 1000;

interface ContactInfo {
    /** Nazwa z Twojej książki adresowej albo nazwa grupy. */
    saved: string | null;
    /** Nazwa profilu, którą rozmówca ustawił sobie sam. */
    nick: string | null;
    /** Numer telefonu, same cyfry. */
    number: string | null;
}

interface CachedContact {
    info: ContactInfo | null;
    checkedAt: number;
}

const EMPTY: ContactInfo = { saved: null, nick: null, number: null };

export class IdentityResolver {
    private readonly contacts = new Map<string, CachedContact>();
    /** Mapowanie @lid → numer telefonu. Raz ustalone, już się nie zmienia. */
    private readonly lidToPhone = new Map<string, string>();
    /** Identyfikatory, dla których getChat() zawiódł - nie męczymy go w kółko. */
    private readonly badChats = new Map<string, number>();

    constructor(private readonly client: WaClient) {}

    /**
     * Ustala identyfikator archiwum i nazwę czatu dla danej wiadomości.
     * Zwraca null tylko wtedy, gdy nie ma nawet z czego wziąć identyfikatora.
     */
    async resolve(message: WaMessage | null, rawId: string | null): Promise<ChatIdentity | null> {
        if (!rawId) return null;

        // Grupy mają porządną nazwę od ręki i nigdy nie zmieniają identyfikatora.
        if (rawId.endsWith('@g.us')) {
            const chatName = await this.chatNameOf(message, rawId);
            return {
                id: rawId,
                name: chatName ?? placeholderName(rawId),
                tier: chatName ? NameTier.SAVED : NameTier.ID,
            };
        }

        const isLid = rawId.endsWith('@lid');

        // Przy zwykłym identyfikatorze getChat() zwykle od razu daje nazwę
        // z książki adresowej. Przy @lid go nie wołamy - wywraca się w środku
        // przeglądarki i tylko zaśmieca plik z błędami.
        let saved = isLid ? null : await this.chatNameOf(message, rawId);

        const phone = isLid ? await this.phoneForLid(rawId) : phoneDigits(rawId);
        const id = phone ? `${phone}@c.us` : rawId;

        // Pytamy o kontakt pod każdym identyfikatorem, jaki mamy: przy @lid
        // numer bywa znany tylko jednej z tych dróg.
        const info = mergeInfo(
            await this.contactInfo(rawId),
            phone ? await this.contactInfo(id) : null,
        );

        saved = saved ?? info.saved;
        const nick = info.nick ?? pushNameOf(message, rawId);
        const number = info.number ?? phone;

        if (saved) return { id, name: saved, tier: NameTier.SAVED };
        if (nick) return { id, name: nick, tier: NameTier.NICK };
        if (number) return { id, name: number, tier: NameTier.NUMBER };
        return { id, name: placeholderName(rawId), tier: NameTier.ID };
    }

    /**
     * Numer telefonu spod identyfikatora @lid. Korzystamy z publicznego
     * getContactLidAndPhone() z whatsapp-web.js - to jedyna droga, która
     * działa, gdy WhatsApp przysyła już wyłącznie @lid.
     */
    async phoneForLid(lid: string): Promise<string | null> {
        const known = this.lidToPhone.get(lid);
        if (known) return known;
        if (typeof this.client.getContactLidAndPhone !== 'function') return null;

        try {
            const pairs = await this.client.getContactLidAndPhone([lid]);
            const phone = phoneDigits(pairs?.[0]?.pn);
            if (phone) {
                this.lidToPhone.set(lid, phone);
                return phone;
            }
        } catch (err) {
            // Zdarza się, gdy WhatsApp Web jeszcze się nie zsynchronizował.
            // Kolejna wiadomość spróbuje ponownie, więc to nie jest awaria.
            log.quiet(err, { stage: 'getContactLidAndPhone', chat: lid });
        }
        return null;
    }

    /**
     * Nazwa czatu z getChat(). Przy @lid nie wołane - patrz resolve().
     *
     * getChat() serializuje cały model rozmowy i dla grupy bez dociągniętych
     * metadanych kończy się zminifikowanym "r: r" - grupa zostawała wtedy
     * w archiwum pod samym identyfikatorem. Dlatego zarówno po nieudanym
     * wywołaniu, jak i po pustej odpowiedzi pytamy jeszcze Store wprost
     * o sam tytuł. Ten odczyt jest tani i nie ma się na czym wywrócić.
     */
    private async chatNameOf(message: WaMessage | null, rawId: string): Promise<string | null> {
        const failedAt = this.badChats.get(rawId);
        const cooling = failedAt !== undefined && Date.now() - failedAt < CONTACT_RETRY_MS;

        if (message && typeof message.getChat === 'function' && !cooling) {
            try {
                const chat = await message.getChat();
                this.badChats.delete(rawId);
                const name = chat?.name?.trim();
                if (name && name.length > 0) return name;
            } catch (err) {
                this.badChats.set(rawId, Date.now());
                log.quiet(err, { stage: 'getChat', chat: rawId });
            }
        }

        // Tylko dla grup. Dla rozmowy z jedną osobą Store oddałby
        // formattedTitle, a to dla nierozpoznanego numeru jest po prostu
        // "+48 880 969 041" - nazwa gorsza niż numer, którym i tak
        // prowadzimy taki czat, a przy tym udająca wpis z książki adresowej.
        if (!rawId.endsWith('@g.us')) return null;

        const subject = await readChatSubject(this.client, rawId);
        if (subject) this.badChats.delete(rawId);
        return subject;
    }

    /**
     * Kontakt spod identyfikatora. Pustą odpowiedź też zapamiętujemy, ale
     * na krótko - kontakt bywa dosyłany z opóźnieniem, zwłaszcza zaraz po
     * starcie, gdy WhatsApp Web dopiero synchronizuje dane.
     */
    async contactInfo(id: string): Promise<ContactInfo | null> {
        const cached = this.contacts.get(id);
        if (cached) {
            // Także nazwa z książki adresowej może zostać zmieniona na
            // telefonie. Cache ogranicza liczbę zapytań, ale nie jest wieczny.
            if (Date.now() - cached.checkedAt < CONTACT_RETRY_MS) return cached.info;
        }
        if (typeof this.client.getContactById !== 'function') return null;

        let info: ContactInfo | null = null;
        try {
            const contact = (await this.client.getContactById(id)) as WaContact | null;
            if (contact) info = readContact(contact, id);
        } catch (err) {
            // Tylko przy pierwszym podejściu - kolejne dołożyłyby to samo
            // co pięć minut i wypchnęły z pliku prawdziwe błędy.
            if (!cached) log.quiet(err, { stage: 'getContactById', chat: id });
        }

        this.contacts.set(id, { info, checkedAt: Date.now() });
        return info;
    }

    /**
     * Wyrzuca cache po synchronizacji. Odpowiedzi sprzed synchronizacji mogły
     * być niepełne, a zapisane nazwy mogły zmienić się na telefonie.
     */
    refreshAfterSync(): void {
        this.contacts.clear();
        this.badChats.clear();
    }
}

// -- Funkcje bez stanu, wygodne do testowania osobno ----------------------

/**
 * Wyciąga z kontaktu trzy rzeczy, które nas interesują. Uwaga na @lid:
 * gdy WhatsApp nie zna numeru, w polach kontaktu zostają cyfry samego
 * identyfikatora - a te numerem telefonu nie są i nie wolno ich za taki podać.
 */
export function readContact(contact: WaContact, queriedId: string): ContactInfo {
    const lidUser = queriedId.endsWith('@lid') ? queriedId.split('@')[0] : null;

    const serialized = contact.id?._serialized;
    const candidates = [
        contact.number,
        serialized && !serialized.endsWith('@lid') ? serialized : null,
    ];

    let number: string | null = null;
    for (const candidate of candidates) {
        const digits = phoneDigits(candidate);
        if (digits && digits !== lidUser) {
            number = digits;
            break;
        }
    }

    // shortName ma sens jako nazwa z książki tylko dla faktycznie zapisanego
    // kontaktu; u niezapisanego bywa skróconym numerem i zasłania pushname.
    const saved = clean(contact.name) ?? (contact.isMyContact ? clean(contact.shortName) : null);
    const nick = clean(contact.pushname) ?? clean(contact.verifiedName);

    return { saved, nick, number };
}

/**
 * Nazwa profilu, którą rozmówca ustawił sobie sam. Przychodzi razem
 * z wiadomością, więc nie kosztuje ani zapytania, ani czekania.
 * W grupie to nazwa nadawcy, nie nazwa grupy - stąd wykluczenie @g.us.
 */
export function pushNameOf(message: WaMessage | null, chatId: string): string | null {
    if (!message || message.fromMe) return null;
    if (chatId.endsWith('@g.us')) return null;
    return clean(message._data?.notifyName) ?? clean(message._data?.pushName);
}

/**
 * Nazwa zastępcza, gdy nie znamy ani nazwy, ani numeru - same cyfry
 * z identyfikatora. Po niej poznajemy czat, który wciąż czeka
 * na coś sensowniejszego.
 */
export function placeholderName(chatId: string): string {
    return chatId.split('@')[0] || chatId || 'nieznany';
}

/** Identyfikator czatu prosto z wiadomości, bez pytania przeglądarki. */
export function chatIdOf(message: WaMessage | null): string | null {
    if (!message) return null;
    const direct = message.fromMe ? message.to : message.from;
    if (typeof direct === 'string' && direct.length > 0) return direct;

    const remote = (message.id as { remote?: unknown } | undefined)?.remote;
    if (typeof remote === 'string') return remote;
    if (remote && typeof remote === 'object' && '_serialized' in remote) {
        return String((remote as { _serialized?: unknown })._serialized ?? '') || null;
    }
    return null;
}

/**
 * Trwały identyfikator wiadomości.
 *
 * Zwykłe wiadomości mają gotowe id._serialized. Relacje z getBroadcasts() -
 * nie: whatsapp-web.js buduje je z surowego serialize() kolekcji statusów,
 * gdzie tego pola po prostu nie ma. Bez własnego klucza każdy przegląd
 * zapisywał te same relacje od nowa, a mediów nie dawało się dopasować
 * do modelu w przeglądarce.
 */
export function messageKey(message: WaMessage | null): string | null {
    const protocolId = (message as (WaMessage & { protocolMessageKey?: unknown }) | null)
        ?.protocolMessageKey as RawMessageId | string | undefined;
    if (message?.type === 'revoked' && protocolId) {
        const key = serializedMessageId(protocolId);
        if (key) return key;
    }

    return serializedMessageId(message?.id as RawMessageId | string | undefined);
}

function serializedMessageId(id: RawMessageId | string | undefined): string | null {
    if (!id) return null;
    if (typeof id === 'string') return id || null;

    if (typeof id._serialized === 'string' && id._serialized.length > 0) return id._serialized;

    // Składamy klucz tak, jak robi to sam WhatsApp: fromMe_rozmówca_skrót.
    const remote = serializedOf(id.remote);
    const hash = typeof id.id === 'string' && id.id.length > 0 ? id.id : null;
    if (!hash) return null;
    if (!remote) return hash;

    const participant = serializedOf(id.participant);
    return `${id.fromMe ? 'true' : 'false'}_${remote}_${hash}${participant ? `_${participant}` : ''}`;
}

/** Sam skrót wiadomości - po nim rozpoznajemy model w przeglądarce. */
export function messageHash(message: WaMessage | null): string | null {
    const id = message?.id as RawMessageId | string | undefined;
    if (!id || typeof id === 'string') return null;
    return typeof id.id === 'string' && id.id.length > 0 ? id.id : null;
}

interface RawMessageId {
    _serialized?: string;
    id?: string;
    remote?: unknown;
    participant?: unknown;
    fromMe?: boolean;
}

function serializedOf(value: unknown): string | null {
    if (typeof value === 'string') return value || null;
    if (value && typeof value === 'object' && '_serialized' in value) {
        const inner = (value as { _serialized?: unknown })._serialized;
        return typeof inner === 'string' && inner.length > 0 ? inner : null;
    }
    return null;
}

/** Nazwa nadawcy do wyświetlenia przy wiadomości. */
export function contactDisplayName(contact: WaContact | null): string | null {
    if (!contact) return null;
    return (
        clean(contact.name) ??
        clean(contact.pushname) ??
        clean(contact.shortName) ??
        clean(contact.number)
    );
}

function clean(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function mergeInfo(first: ContactInfo | null, second: ContactInfo | null): ContactInfo {
    const a = first ?? EMPTY;
    const b = second ?? EMPTY;
    return {
        saved: a.saved ?? b.saved,
        nick: a.nick ?? b.nick,
        number: a.number ?? b.number,
    };
}
