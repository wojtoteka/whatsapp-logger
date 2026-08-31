// Kształty danych, które panel czyta z archiwum.
//
// To ten sam zapis, który logger tworzy w logs/ - panel niczego nie
// przelicza ani nie trzyma u siebie. Jedno źródło prawdy: pliki na dysku.

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

/** Jedna wiadomość, dokładnie tak jak zapisał ją logger. */
export interface ArchivedMessage {
    id: string;
    timestamp: number;
    from: string;
    fromMe: boolean;
    /** Ścieżka względem folderu czatu. */
    avatar: string | null;
    body: string;
    type: string;
    /** Ścieżka względem folderu czatu. */
    mediaPath: string | null;
    mediaName: string | null;
    mediaSkipped: SkippedMedia | null;
    isDeleted: boolean;
    /** Pole opcjonalne dla zgodności ze starszymi archiwami. */
    deletedAt?: string | null;
    /**
     * Stan doręczenia własnej wiadomości: 1 na serwerze, 2 na telefonie
     * odbiorcy, 3 przeczytana, 4 odsłuchana. Pole opcjonalne - starsze
     * archiwum go nie ma.
     */
    ack?: number | null;
    /** Kiedy logger zobaczył doręczenie na telefon odbiorcy. */
    deliveredAt?: string | null;
    /**
     * Kiedy logger zobaczył odczytanie. Bywa puste przy wiadomości
     * przeczytanej - WhatsApp nie podaje godziny, więc znamy ją tylko wtedy,
     * gdy logger pracował w chwili odczytu.
     */
    readAt?: string | null;
    isForwarded: boolean;
    quotedMsg: QuotedInfo | null;
    location: LocationInfo | null;
    contacts: VCardInfo[] | null;
    poll: PollInfo | null;
}

/** Zawartość messages_XXXX.json. */
export interface BatchFile {
    chatName: string;
    batchNum: number;
    savedAt: string;
    messages: ArchivedMessage[];
}

/** Zawartość _state.json - partia, która jeszcze się nie zamknęła. */
export interface ChatStateFile {
    chatName: string;
    nameTier?: number;
    avatar?: string | null;
    batchNum: number;
    totalMessages: number;
    pendingMessages: ArchivedMessage[];
    seenIds?: string[];
    sync?: {
        messageId: string;
        timestamp: number;
        syncedAt: string;
    } | null;
    lastUpdated: string;
}

/** Czat na liście - tyle, ile trzeba, żeby narysować kafelek. */
export interface ChatSummary {
    /** Folder względem logs/, np. "Kontakt" albo "Statusy/Kontakt". */
    folder: string;
    /** Ten sam folder w postaci nadającej się do adresu URL. */
    slug: string;
    name: string;
    isStatus: boolean;
    messageCount: number;
    lastMessageAt: number | null;
    /** Ścieżka względem logs/ albo null. */
    avatar: string | null;
    /** Początek ostatniej wiadomości - podgląd na liście. */
    preview: string | null;
}

/** Strona wiadomości, od najnowszej. */
export interface MessagePage {
    messages: ArchivedMessage[];
    /** Ile wiadomości ma cały czat. */
    total: number;
    /** Czy da się przewinąć dalej wstecz. */
    hasOlder: boolean;
    /** Opaque cursor do następnej, starszej paczki. */
    nextCursor: string | null;
}
