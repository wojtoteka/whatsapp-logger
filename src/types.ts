// Kształty danych wędrujące między modułami.
//
// Osobno trzymamy też typy "surowe" - to, co whatsapp-web.js faktycznie
// wkłada do obiektów, a czego nie ma w jego deklaracjach .d.ts. Sięgamy
// po nie w kilku miejscach, więc lepiej mieć to nazwane niż rzutować
// w kółko na "any".

import type { Client, Contact, Message } from 'whatsapp-web.js';
import type { Page } from 'puppeteer';

/** Jak dobrą nazwę czatu udało się zdobyć. Wyżej znaczy lepiej. */
export const NameTier = {
    /** Same cyfry z identyfikatora - nic nam nie mówią. */
    ID: 0,
    /** Numer telefonu. */
    NUMBER: 1,
    /** Nazwa profilu ustawiona przez rozmówcę. */
    NICK: 2,
    /** Nazwa z Twojej książki adresowej albo nazwa grupy. */
    SAVED: 3,
} as const;

export type NameTier = (typeof NameTier)[keyof typeof NameTier];

/** Ustalona tożsamość czatu: pod czym go prowadzimy i jak nazywamy. */
export interface ChatIdentity {
    /** Klucz archiwum. Dla relacji z przedrostkiem "status:". */
    id: string;
    name: string;
    tier: NameTier;
}

/** Plik, którego nie zapisaliśmy - w archiwum zostaje po nim notatka. */
export interface SkippedMedia {
    reason: string;
    type: string;
    filename: string | null;
    bytes: number | null;
}

export interface QuotedInfo {
    sender: string;
    body: string;
}

export interface LocationInfo {
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
}

export interface VCardInfo {
    name: string | null;
    numbers: string[];
    org: string | null;
}

export interface PollInfo {
    question: string | null;
    options: string[];
    multiple: boolean;
}

/** Jedna wiadomość w formie, w jakiej trafia do _state.json i do HTML. */
export interface ArchivedMessage {
    id: string;
    /** Uniksowy znacznik czasu w sekundach, tak jak podaje go WhatsApp. */
    timestamp: number;
    from: string;
    fromMe: boolean;
    /** Ścieżka do zdjęcia profilowego, względem folderu czatu. */
    avatar: string | null;
    body: string;
    type: string;
    /** Ścieżka do pobranego pliku, względem folderu czatu. */
    mediaPath: string | null;
    mediaName: string | null;
    mediaSkipped: SkippedMedia | null;
    isDeleted: boolean;
    isForwarded: boolean;
    quotedMsg: QuotedInfo | null;
    location: LocationInfo | null;
    contacts: VCardInfo[] | null;
    poll: PollInfo | null;
}

/**
 * Zawartość messages_XXXX.json - ta sama partia co w pliku HTML, tyle że
 * w postaci danych. Czyta ją panel, żeby nie rozbierać gotowej strony.
 */
export interface BatchFile {
    chatName: string;
    batchNum: number;
    savedAt: string;
    messages: ArchivedMessage[];
}

/** Zawartość _state.json jednego czatu. */
export interface ChatStateFile {
    chatName: string;
    nameTier: NameTier;
    batchNum: number;
    totalMessages: number;
    pendingMessages: ArchivedMessage[];
    /** Identyfikatory już zapisanych relacji - żeby nie dublować. */
    seenIds?: string[];
    lastUpdated: string;
}

/** Wpis w logs/_czaty.json - gdzie i pod jaką nazwą leży dany czat. */
export interface ChatIndexEntry {
    name: string;
    /** Nazwa folderu względem logs/. Dla relacji "Statusy/<autor>". */
    safeName: string;
    tier: NameTier;
}

/** Jedna wersja zdjęcia profilowego. */
export interface AvatarVersion {
    /** Ścieżka względem logs/_avatars. */
    file: string;
    /** Suma kontrolna - po niej poznajemy, że zdjęcie się nie zmieniło. */
    sha: string | null;
    /** Od kiedy ta wersja obowiązuje. */
    since: string | null;
}

export interface AvatarRecord {
    /** Kiedy ostatnio pytaliśmy WhatsAppa. null = jeszcze nigdy. */
    checkedAt: string | null;
    versions: AvatarVersion[];
}

// ── Kształty, których nie ma w deklaracjach whatsapp-web.js ──────────────

/** Pola, które biblioteka wkłada do wiadomości, a których nie deklaruje. */
export interface RawMessageData {
    notifyName?: string;
    pushName?: string;
    filename?: string;
    size?: number;
    isStatusV3?: boolean;
    [key: string]: unknown;
}

export interface WaMessage extends Message {
    _data?: RawMessageData;
    isStatusV3?: boolean;
    /** Klient, przez który wiadomość przyszła - używany przy relacjach. */
    client?: WaClient;
}

export interface WaClient extends Client {
    pupPage?: Page;
}

/**
 * Kontakt. Biblioteka deklaruje verifiedName jako undefined, choć w praktyce
 * bywa tam napis - odczytujemy go przez rzutowanie w identity.ts.
 */
export type WaContact = Contact;

/** Wynik pobrania pliku z wiadomości. */
export interface DownloadedMedia {
    data: string;
    mimetype?: string;
    filename?: string;
    filesize?: number;
}
