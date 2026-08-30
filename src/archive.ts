// Serce programu: zamiana wiadomości z WhatsAppa na pliki w archiwum.
//
// Każdy czat ma swój folder, w nim kolejne pliki messages_0001.html po
// MESSAGES_PER_FILE wiadomości, podfolder media i _state.json z tym, co nie
// zdążyło jeszcze wypełnić partii. Jeden czat obsługiwany jest po kolei
// (kolejka promisów), więc dwie wiadomości nigdy nie wchodzą sobie w drogę.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config';
import type { Database } from './db';
import { toArchivePath as toDatabaseArchivePath, toMessageRow } from './db';
import { AvatarStore } from './avatars';
import {
    batchDataName,
    batchFileName,
    generateHtml,
    markDeletedInHtml,
    NEXT_LINK_MARKER,
    buildNextLink,
    titleSwaps,
    typeLabel,
} from './html';
import {
    chatIdOf,
    contactDisplayName,
    IdentityResolver,
    messageKey,
    NAME_RETRY_MS,
    placeholderName,
} from './identity';
import { describeError, log } from './log';
import { MediaDownloader } from './media';
import {
    bareId,
    isStatusChat,
    isStatusMessage,
    STATUS_DIR,
    statusAuthorId,
    statusChatId,
} from './statuses';
import { NameTier } from './types';
import {
    clearFullHistoryScan,
    prepareFullHistoryScan,
    readFullHistoryBatch,
} from './waClient';
import type {
    ArchivedMessage,
    BatchFile,
    ChatIndexEntry,
    ChatStateFile,
    LocationInfo,
    PollInfo,
    QuotedInfo,
    SyncCheckpoint,
    VCardInfo,
    WaClient,
    WaContact,
    WaMessage,
} from './types';
import {
    ensureDir,
    listDir,
    listDirents,
    move,
    pathExists,
    readJson,
    readJsonSync,
    safeFileName,
    writeFileAtomic,
    writeJsonAtomic,
    sleep,
} from './util';

/** Wiadomości systemowe, których nie ma sensu archiwizować. */
const IGNORED_TYPES = new Set([
    'e2e_notification',
    'notification_template',
    'call_log',
    'gp2',
    'broadcast_notification',
    'protocol',
]);

/** Tyle ostatnich identyfikatorów wystarczy do bezpiecznego nadrabiania historii. */
const SEEN_ID_LIMIT = 10_000;

/**
 * syncHistory() 1.34.6 potwierdza wysłanie żądania, nie otrzymanie danych.
 * Po pozytywnym wyniku dajemy stronie krótki czas na przyjęcie odpowiedzi.
 */
const PEER_SYNC_SETTLE_MS = 3_000;

interface ChatState {
    id: string;
    name: string;
    nameTier: NameTier;
    isStatus: boolean;
    /** Nazwa folderu względem logs/. Dla relacji "Statusy/<autor>". */
    safeName: string;
    chatDir: string;
    mediaDir: string;
    batchNum: number;
    totalMessages: number;
    pending: ArchivedMessage[];
    seenIds: string[];
    seenIdSet: Set<string>;
    sync: SyncCheckpoint | null;
    saveTimer: NodeJS.Timeout | null;
    lastSaveAt: number;
    /** Identyfikator prosto z wiadomości, zwykle @lid. */
    rawId: string | null;
    nameRetryAt: number;
    /** Ostatnia ścieżka zdjęcia zapisana do bazy - żeby nie pisać w kółko. */
    lastAvatarPath: string | null;
    currentAvatar: string | null;
}

export interface StatusSweepStats {
    saved: number;
    skipped: number;
}

export interface BackfillStats {
    chats: number;
    /** Czaty bez istniejącego folderu pominięte podczas zwykłego startu. */
    skippedNewChats: number;
    /** Nie udało się nawet ustalić listy czatów. */
    listingFailed: boolean;
    scanned: number;
    saved: number;
    skipped: number;
    failedChats: number;
    /** Czaty, dla których tryb pełny utworzył nowe archiwum. */
    newChats: number;
    /** Istniejące rekordy zmienione podczas synchronizacji, np. oznaczone jako usunięte. */
    updated: number;
    /** Czy żądany zakres historii został pobrany w całości. */
    complete: boolean;
}

export interface BackfillOptions {
    /** true pozwala utworzyć foldery dla czatów, których nie ma w archiwum. */
    includeNewChats?: boolean;
    /** Pobiera całą historię, którą bieżąca sesja WhatsApp Web udostępnia. */
    fullHistory?: boolean;
    /** Postęp dla trybu interaktywnego, np. --nadrob-wszystko. */
    onProgress?: (progress: BackfillProgress) => void;
}

export interface BackfillProgress {
    percent: number;
    stage: 'listing' | 'opening' | 'syncing' | 'fetching' | 'saving' | 'done';
    detail: string;
    chat?: string;
}

type BackfillChat = Awaited<ReturnType<WaClient['getChats']>>[number];

interface BackfillChatList {
    chats: BackfillChat[];
    skippedNewChats: number;
    failedChats: number;
    newChatIds: string[];
    /** Lista powstała z zapasowego źródła, więc na pewno nie jest pełna. */
    listingDegraded?: boolean;
}

export class Archive {
    private readonly states = new Map<string, ChatState>();
    private readonly queues = new Map<string, Promise<unknown>>();
    /** Identyfikatory czatów zabezpieczonych kodem, tylko do oznaczeń w konsoli. */
    private readonly lockedChatIds = new Set<string>();
    /** Identyfikator z wiadomości → klucz, pod którym prowadzimy archiwum. */
    private readonly aliases = new Map<string, string>();
    private readonly index = new Map<string, ChatIndexEntry>();
    private readonly indexFile: string;

    private readonly identity: IdentityResolver;
    private readonly media: MediaDownloader;
    private readonly avatars: AvatarStore;

    constructor(
        private readonly config: Config,
        private readonly client: WaClient,
        /** Opcjonalna baza. Bez niej działa samo archiwum na dysku. */
        private readonly db: Database | null = null,
    ) {
        this.indexFile = path.join(config.logsDir, '_czaty.json');
        this.identity = new IdentityResolver(client);
        this.media = new MediaDownloader(config);
        this.avatars = new AvatarStore(config, client);
        this.loadIndex();
    }

    /** Folder archiwum - potrzebny modułowi kasującemu stare pliki. */
    get logsDir(): string {
        return this.config.logsDir;
    }

    /**
     * Bieżąca partia dla ?tau. Może być o kilka sekund świeższa niż
     * _state.json, bo normalny zapis stanu jest celowo ograniczany czasowo.
     */
    pendingMessagesFor(folder: string): readonly ArchivedMessage[] | null {
        const state = [...this.states.values()].find((candidate) => candidate.safeName === folder);
        return state ? [...state.pending] : null;
    }

    /** Aktualizuje listę zwróconą przez WhatsApp Web; niczego nie zapisuje na dysk. */
    setLockedChatIds(ids: readonly string[]): void {
        this.lockedChatIds.clear();
        for (const id of ids) {
            const clean = id.trim();
            if (clean) this.lockedChatIds.add(clean);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Zapis wiadomości
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Główne wejście: bierze wiadomość z WhatsAppa i dopisuje ją do archiwum.
     * Zwraca true, gdy faktycznie coś doszło - przegląd relacji liczy po tym,
     * ile rzeczy było nowych.
     */
    async save(
        message: WaMessage,
        options: { forceStatus?: boolean; knownIds?: ReadonlySet<string> } = {},
    ): Promise<boolean> {
        try {
            if (IGNORED_TYPES.has(message.type)) return false;

            // Podczas synchronizacji WhatsApp może zwrócić już tylko model
            // typu "revoked". Nie dokładamy go jako pustej wiadomości -
            // aktualizujemy wcześniej zapisany rekord.
            if (message.type === 'revoked') {
                await this.markDeleted(message);
                return false;
            }

            const isStatus = options.forceStatus === true || isStatusMessage(message);
            const rawId = isStatus ? statusAuthorId(message) : chatIdOf(message);
            if (!rawId) {
                log.debug('Pominięto wiadomość - nie da się ustalić czatu');
                return false;
            }

            // Relacje i zwykła rozmowa tej samej osoby mają ten sam rawId,
            // a dwa różne foldery - stąd osobny klucz w spisie skrótów.
            const aliasKey = isStatus ? statusChatId(rawId) : rawId;
            let chatId = this.aliases.get(aliasKey) ?? null;

            if (!chatId) {
                chatId = await this.resolveChatId(message, rawId, isStatus);
                if (!chatId) return false;
                this.aliases.set(aliasKey, chatId);
            }

            return await this.enqueue(chatId, () =>
                this.process(message, chatId, rawId, options.knownIds),
            );
        } catch (err) {
            log.error('Błąd zapisu wiadomości', err, {
                stage: 'save',
                messageId: messageKey(message),
                messageType: message.type,
            });
            return false;
        }
    }

    /** Ustala klucz archiwum dla nowo widzianego czatu. */
    private async resolveChatId(
        message: WaMessage,
        rawId: string,
        isStatus: boolean,
    ): Promise<string | null> {
        // Własne relacje nie mają identyfikatora kontaktu - to zawsze "Ja".
        if (isStatus && rawId === 'me') {
            const chatId = statusChatId('me');
            if (!this.states.has(chatId)) {
                await this.initState(chatId, 'Ja', NameTier.SAVED, rawId);
            }
            return chatId;
        }

        const identity = await this.identity.resolve(message, rawId);
        const baseId = identity?.id ?? rawId;
        const chatId = isStatus ? statusChatId(baseId) : baseId;

        if (!this.states.has(chatId)) {
            await this.initState(
                chatId,
                identity?.name ?? placeholderName(rawId),
                identity?.tier ?? NameTier.ID,
                rawId,
            );
        }
        return chatId;
    }

    /** Właściwe przetworzenie wiadomości - już w kolejce danego czatu. */
    private async process(
        message: WaMessage,
        chatId: string,
        rawId: string,
        knownIds?: ReadonlySet<string>,
    ): Promise<boolean> {
        const state = this.states.get(chatId);
        if (!state) return false;

        const msgId = archiveMessageId(message, state.id);

        // Nazwę sprawdzamy również przy duplikacie z synchronizacji. Dzięki
        // temu zmiana nazwy kontaktu nie wymaga nowej wiadomości w rozmowie.
        await this.maybeUpgradeName(message, state, rawId);

        // Zdarzenie na żywo i przegląd historii mogą podać tę samą wiadomość.
        // Tryb pełny przekazuje dodatkowo komplet ID istniejącego archiwum,
        // bo jego zakres może być większy niż szybki cache ostatnich 10 000.
        if (state.seenIdSet.has(msgId) || knownIds?.has(msgId)) return false;

        let senderName = 'Ja';
        let avatar: string | null = null;

        if (!message.fromMe) {
            let contact: WaContact | null = null;
            try {
                contact = (await message.getContact()) as WaContact;
            } catch {
                // Zostanie sam numer; zdjęcie i tak spróbujemy pobrać.
            }
            senderName =
                contactDisplayName(contact) ?? message.author ?? message.from ?? 'Nieznany';
            avatar = await this.avatars.pathFor(contact, message, state.chatDir);
        }

        const media = await this.media.download(message, {
            mediaDir: state.mediaDir,
            chatDir: state.chatDir,
            isStatus: state.isStatus,
            label: state.name,
        });

        const entry: ArchivedMessage = {
            id: msgId,
            timestamp: message.timestamp,
            from: senderName,
            fromMe: message.fromMe,
            avatar,
            // Uwaga: przy zdjęciach i filmach whatsapp-web.js wkłada podpis
            // właśnie do body - osobnego pola z podpisem nie ma.
            body: message.body || '',
            type: message.type,
            mediaPath: media.path,
            mediaName: media.name,
            mediaSkipped: media.skipped,
            isDeleted: false,
            deletedAt: null,
            isForwarded: message.isForwarded === true,
            quotedMsg: await this.quotedInfo(message),
            location: locationInfo(message),
            contacts: vCardInfo(message),
            poll: pollInfo(message),
        };

        this.rememberMessageId(state, msgId);
        state.pending.push(entry);
        state.totalMessages++;

        // Baza dostaje wiadomość od razu, nie dopiero przy zamknięciu partii -
        // panel ma pokazywać rozmowę na bieżąco, a nie co 70 wiadomości.
        const row = toMessageRow(entry, state.id, state.safeName);
        await this.db?.saveMessage(row);

        // Zdjęcie czatu w bazie aktualizujemy tylko wtedy, gdy faktycznie się
        // zmieniło - inaczej byłby jeden UPDATE na każdą wiadomość.
        if (row.avatarPath && row.avatarPath !== state.lastAvatarPath) {
            state.lastAvatarPath = row.avatarPath;
            state.currentAvatar = avatar;
            await this.db?.setChatAvatar(state.id, row.avatarPath);
        }

        if (state.pending.length >= this.config.messagesPerFile) {
            await this.flushBatch(state);
        } else if (state.isStatus) {
            // Identyfikator relacji musi trafić na dysk od razu - po restarcie
            // program nie zapisze jej drugi raz, nawet gdy padnie za chwilę.
            await this.saveState(state);
        } else {
            await this.scheduleStateSave(state);
        }

        const isLocked = this.lockedChatIds.has(rawId) || this.lockedChatIds.has(chatId);
        log.info(formatMessageLine(state.name, entry, isLocked));

        return true;
    }

    /** Dopisuje ID do trwałego, ograniczonego zbioru używanego przy nadrabianiu. */
    private rememberMessageId(state: ChatState, msgId: string): void {
        state.seenIds.push(msgId);
        state.seenIdSet.add(msgId);

        while (state.seenIds.length > SEEN_ID_LIMIT) {
            const removed = state.seenIds.shift();
            if (removed) state.seenIdSet.delete(removed);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Nadrabianie po uruchomieniu
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Przegląda ostatnie wiadomości czatów widocznych dla WhatsApp Weba.
     * Zwykły start dotyka tylko istniejącego archiwum; jawna komenda może
     * włączyć includeNewChats i założyć foldery także dla pozostałych.
     * save() prowadzi wiadomości tą samą ścieżką co zdarzenia na żywo, więc
     * media, baza, nazwy i deduplikacja zachowują się identycznie.
     */
    async backfillRecent(
        limit = this.config.backfillMessagesPerChat,
        options: BackfillOptions = {},
    ): Promise<BackfillStats> {
        const stats: BackfillStats = {
            chats: 0,
            skippedNewChats: 0,
            listingFailed: false,
            scanned: 0,
            saved: 0,
            skipped: 0,
            failedChats: 0,
            newChats: 0,
            updated: 0,
            complete: true,
        };
        const fullHistory = options.fullHistory === true;
        const wanted = fullHistory ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(limit));
        if (wanted === 0 || typeof this.client.getChats !== 'function') return stats;

        const progress = (
            percent: number,
            stage: BackfillProgress['stage'],
            detail: string,
            chat?: string,
        ): void => {
            options.onProgress?.({
                percent: Math.max(0, Math.min(100, Math.round(percent))),
                stage,
                detail,
                ...(chat ? { chat } : {}),
            });
        };

        progress(0, 'listing', 'pobieram listę czatów');

        let listed: BackfillChatList;
        try {
            listed = await this.chatsForBackfill(
                options.includeNewChats === true,
                (current, total, chat) => {
                    const percent = total > 0 ? (current / total) * 10 : 10;
                    progress(percent, 'opening', `otwieram czat ${current}/${total}`, chat);
                },
            );
        } catch (err) {
            stats.listingFailed = true;
            stats.complete = false;
            log.error('Nie udało się pobrać czatów do nadrobienia', err, {
                stage: 'nadrabianie: lista czatów',
            });
            return stats;
        }
        stats.skippedNewChats = listed.skippedNewChats;
        stats.failedChats = listed.failedChats;
        if (listed.failedChats > 0 || listed.listingDegraded) stats.complete = false;

        if (listed.chats.length === 0) {
            progress(100, 'done', 'brak czatów do przetworzenia');
            return stats;
        }

        const chatTotal = listed.chats.length;
        for (const [chatIndex, chat] of listed.chats.entries()) {
            const chatId = chat.id?._serialized ?? null;
            const chatName = chat.name?.trim() || chatId || 'nieznany czat';
            const chatStart = 10 + (chatIndex / chatTotal) * 90;
            const chatShare = 90 / chatTotal;
            stats.chats++;
            try {
                // Prosimy urządzenie główne o świeżą historię, ale brak tej
                // możliwości nie blokuje odczytu tego, co już ma Web.
                if (typeof chat.syncHistory === 'function') {
                    progress(
                        chatStart + chatShare * 0.1,
                        'syncing',
                        `synchronizuję historię (${chatIndex + 1}/${chatTotal})`,
                        chatName,
                    );
                    try {
                        const requested = await chat.syncHistory();
                        // W 1.34.6 true oznacza wysłanie żądania do urządzenia
                        // głównego, nie dostarczenie wiadomości. Krótka pauza
                        // pozwala Store przyjąć odpowiedź przed fetchMessages.
                        if (requested) await sleep(PEER_SYNC_SETTLE_MS);
                    } catch (err) {
                        log.quiet(err, { stage: 'nadrabianie: syncHistory', chat: chatId });
                    }
                }

                progress(
                    chatStart + chatShare * 0.25,
                    'fetching',
                    fullHistory
                        ? `przygotowuję pełną historię (${chatIndex + 1}/${chatTotal})`
                        : `pobieram do ${wanted} wiadomości (${chatIndex + 1}/${chatTotal})`,
                    chatName,
                );

                if (fullHistory && chatId) {
                    const scan = await prepareFullHistoryScan(this.client, chatId);
                    if (scan.supported) {
                        const knownIds = await this.allMessageIds(chatId);
                        let newest: WaMessage | null = null;
                        const batchSize = 250;
                        try {
                            for (let offset = 0; offset < scan.total; offset += batchSize) {
                                const messages = await readFullHistoryBatch(
                                    this.client,
                                    chatId,
                                    offset,
                                    batchSize,
                                );
                                if (messages.length === 0 && offset < scan.total) {
                                    throw new Error('WhatsApp Web przerwał odczyt przygotowanej historii');
                                }
                                newest = messages[messages.length - 1] ?? newest;
                                await this.saveBackfillBatch(messages, stats, knownIds, null);
                                const done = Math.min(offset + messages.length, scan.total);
                                const part = scan.total > 0 ? done / scan.total : 1;
                                progress(
                                    chatStart + chatShare * (0.3 + part * 0.7),
                                    'saving',
                                    `zapisuję wiadomości ${done}/${scan.total} ` +
                                        `(${chatIndex + 1}/${chatTotal} czatów)`,
                                    chatName,
                                );
                            }
                        } finally {
                            await clearFullHistoryScan(this.client, chatId).catch((err) =>
                                log.quiet(err, { stage: 'czyszczenie pełnego skanu', chat: chatId }),
                            );
                        }
                        if (newest) await this.commitCheckpoint(chatId, newest);
                        progress(
                            chatStart + chatShare,
                            'saving',
                            `zakończono czat ${chatIndex + 1}/${chatTotal}`,
                            chatName,
                        );
                        continue;
                    }

                    // Klient testowy albo przyszła wersja biblioteki bez
                    // zweryfikowanych modułów Store. Publiczne API pozostaje
                    // poprawnym, choć pamięciożernym planem awaryjnym.
                    log.warn(
                        `Pełne nadrabianie ${chatName}: brak odczytu paczkowego, używam publicznego fetchMessages.`,
                    );
                }
                let requestedLimit = wanted;
                let messages = (await chat.fetchMessages({ limit: requestedLimit })) as WaMessage[];

                const checkpoint = fullHistory ? null : await this.checkpointFor(chatId);
                if (checkpoint && Number.isFinite(requestedLimit)) {
                    // Jeśli cała paczka jest nowsza od checkpointu, przerwa
                    // offline była większa niż zwykłe okno. Pogłębiamy je
                    // stopniowo, zamiast skanować całą historię od początku.
                    let previousLength = -1;
                    while (
                        !containsCheckpoint(messages, checkpoint) &&
                        oldestTimestamp(messages) > checkpoint.timestamp &&
                        messages.length > previousLength &&
                        requestedLimit < 50_000
                    ) {
                        previousLength = messages.length;
                        requestedLimit = Math.min(requestedLimit * 2, 50_000);
                        progress(
                            chatStart + chatShare * 0.27,
                            'fetching',
                            `pogłębiam zakres do ${requestedLimit} wiadomości`,
                            chatName,
                        );
                        messages = (await chat.fetchMessages({ limit: requestedLimit })) as WaMessage[];
                    }
                    if (
                        !containsCheckpoint(messages, checkpoint) &&
                        oldestTimestamp(messages) > checkpoint.timestamp
                    ) {
                        stats.complete = false;
                        log.warn(
                            `Nadrabianie ${chatName}: checkpoint jest starszy niż bezpieczne okno 50000 wiadomości. ` +
                                'Zapisano dostępny nowszy zakres; uruchom --nadrob-wszystko dla pełnej kontroli.',
                        );
                    }
                }
                messages.sort((a, b) => a.timestamp - b.timestamp);

                // Pełny tryb czyta ID istniejącego archiwum po jednym pliku.
                // Trzymamy tylko identyfikatory jednego czatu, nie wiadomości
                // wszystkich czatów, i zwalniamy zbiór po zakończeniu czatu.
                const knownIds =
                    fullHistory || messages.length > SEEN_ID_LIMIT
                        ? await this.allMessageIds(chatId)
                        : null;
                const newest = messages[messages.length - 1] ?? null;

                for (const [messageIndex, message] of messages.entries()) {
                    if (
                        messageIndex === 0 ||
                        messageIndex === messages.length - 1 ||
                        messageIndex % 10 === 0
                    ) {
                        const messagePart =
                            messages.length > 0 ? (messageIndex + 1) / messages.length : 1;
                        progress(
                            chatStart + chatShare * (0.3 + messagePart * 0.7),
                            'saving',
                            `zapisuję wiadomości ${messageIndex + 1}/${messages.length} ` +
                                `(${chatIndex + 1}/${chatTotal} czatów)`,
                            chatName,
                        );
                    }
                    stats.scanned++;
                    if (message.type === 'revoked') {
                        if (await this.markDeleted(message)) stats.updated++;
                        else stats.skipped++;
                        continue;
                    }
                    if (checkpoint && !fullHistory && !isAfterCheckpoint(message, checkpoint)) {
                        stats.skipped++;
                        continue;
                    }

                    if (await this.save(message, { ...(knownIds ? { knownIds } : {}) })) {
                        stats.saved++;
                        const id = messageKey(message);
                        if (id) knownIds?.add(id);
                    } else {
                        stats.skipped++;
                    }
                }

                if (newest) await this.commitCheckpoint(chatId, newest);
                progress(
                    chatStart + chatShare,
                    'saving',
                    `zakończono czat ${chatIndex + 1}/${chatTotal}`,
                    chatName,
                );
            } catch (err) {
                stats.failedChats++;
                stats.complete = false;
                log.quiet(err, { stage: 'nadrabianie czatu', chat: chatId });
                progress(
                    chatStart + chatShare,
                    'saving',
                    `pominięto czat z błędem ${chatIndex + 1}/${chatTotal}`,
                    chatName,
                );
            }
        }

        for (const chatId of listed.newChatIds) {
            if (await this.hasExistingChatFolder(chatId)) stats.newChats++;
        }

        progress(100, 'done', 'zapis zakończony');
        return stats;
    }

    private async saveBackfillBatch(
        messages: readonly WaMessage[],
        stats: BackfillStats,
        knownIds: Set<string> | null,
        checkpoint: SyncCheckpoint | null,
    ): Promise<void> {
        for (const message of messages) {
            stats.scanned++;
            if (message.type === 'revoked') {
                if (await this.markDeleted(message)) stats.updated++;
                else stats.skipped++;
                continue;
            }
            if (checkpoint && !isAfterCheckpoint(message, checkpoint)) {
                stats.skipped++;
                continue;
            }
            if (await this.save(message, { ...(knownIds ? { knownIds } : {}) })) {
                stats.saved++;
                const id = messageKey(message);
                if (id) knownIds?.add(id);
            } else {
                stats.skipped++;
            }
        }
    }

    /** Checkpoint znanego czatu bez inicjalizowania wszystkich stanów. */
    private async checkpointFor(chatId: string | null): Promise<SyncCheckpoint | null> {
        if (!chatId) return null;
        const canonical = this.aliases.get(chatId) ?? chatId;
        const inMemory = this.states.get(canonical);
        if (inMemory?.sync) return inMemory.sync;

        const known = this.index.get(canonical) ?? this.index.get(chatId);
        if (!known?.safeName) return null;

        const dir = path.join(this.config.logsDir, known.safeName);
        const saved = await readJson<ChatStateFile>(path.join(dir, '_state.json'));
        if (saved?.sync?.messageId) return saved.sync;

        // Migracja starego archiwum: najnowszy rekord staje się pierwszym
        // checkpointem. Czytamy tylko stan i ostatnią partię, nie całą historię.
        let latest = lastByTimestamp(saved?.pendingMessages ?? []);
        if (!latest) {
            const files = (await listDir(dir))
                .filter((file) => /^messages_\d+\.json$/.test(file))
                .sort();
            const lastFile = files[files.length - 1];
            if (lastFile) {
                const batch = await readJson<BatchFile>(path.join(dir, lastFile));
                latest = lastByTimestamp(batch?.messages ?? []);
            }
        }
        return latest
            ? {
                  messageId: latest.id,
                  timestamp: latest.timestamp,
                  syncedAt: saved?.lastUpdated ?? new Date(0).toISOString(),
              }
            : null;
    }

    /** Wszystkie ID jednego czatu, używane wyłącznie przez jawny pełny skan. */
    private async allMessageIds(chatId: string | null): Promise<Set<string>> {
        const ids = new Set<string>();
        if (!chatId) return ids;

        const canonical = this.aliases.get(chatId) ?? chatId;
        const state = this.states.get(canonical);
        const known = this.index.get(canonical) ?? this.index.get(chatId);
        const dir = state?.chatDir ?? (known?.safeName ? path.join(this.config.logsDir, known.safeName) : null);
        if (!dir) return ids;

        const saved = await readJson<ChatStateFile>(path.join(dir, '_state.json'));
        for (const message of saved?.pendingMessages ?? state?.pending ?? []) {
            if (message?.id) ids.add(message.id);
        }

        const files = (await listDir(dir))
            .filter((file) => /^messages_\d+\.json$/.test(file))
            .sort();
        for (const file of files) {
            const batch = await readJson<BatchFile>(path.join(dir, file));
            for (const message of batch?.messages ?? []) {
                if (message?.id) ids.add(message.id);
            }
        }
        return ids;
    }

    /** Zapisuje checkpoint dopiero po zapisaniu wszystkich wiadomości paczki. */
    private async commitCheckpoint(chatId: string | null, newest: WaMessage): Promise<void> {
        if (!chatId) return;
        const rawId = chatIdOf(newest) ?? chatId;
        const canonical = this.aliases.get(rawId) ?? this.aliases.get(chatId) ?? chatId;
        const state = this.states.get(canonical);
        if (!state) return;

        const previous = state.sync;
        state.sync = {
            messageId: archiveMessageId(newest, state.id),
            timestamp: newest.timestamp,
            syncedAt: new Date().toISOString(),
        };
        if (!(await this.saveState(state))) state.sync = previous;
    }

    /**
     * getChats() w whatsapp-web.js serializuje wszystkie czaty równolegle.
     * Jeden wadliwy model (obecnie najczęściej grupa) odrzuca wtedy całą
     * listę krótkim błędem "r: r". Jeśli mamy dostęp do strony, pobieramy
     * więc najpierw same identyfikatory i rozwijamy czaty pojedynczo. Jeden
     * problematyczny czat nie blokuje dzięki temu wszystkich pozostałych.
     *
     * Klienci testowi i przyszłe wersje biblioteki bez pupPage korzystają z
     * publicznego getChats() jako bezpiecznego planu B.
     */
    private async chatsForBackfill(
        includeNewChats: boolean,
        onOpening?: (current: number, total: number, chat: string) => void,
    ): Promise<BackfillChatList> {
        const result: BackfillChatList = {
            chats: [],
            skippedNewChats: 0,
            failedChats: 0,
            newChatIds: [],
        };

        const ids = await this.rawChatIds();
        if (ids) {
            await this.openChatsById(ids, includeNewChats, result, onOpening);
            return result;
        }

        let chats: BackfillChat[];
        try {
            chats = await this.client.getChats();
        } catch (err) {
            // Ostatnia deska ratunku: czaty ze spisu archiwum. Bez niej jeden
            // wadliwy model odbierał nadrabianie wszystkim pozostałym, więc po
            // każdym offline zostawała dziura w rozmowach, które są tu od dawna.
            const known = this.archivedChatIds();
            if (known.length === 0) throw err;

            log.warn(
                `Lista czatów z WhatsAppa nie doszła (${describeError(err)}) - ` +
                    'nadrabiam rozmowy, które są już w archiwum.',
            );
            result.listingDegraded = true;
            await this.openChatsById(known, includeNewChats, result, onOpening);
            return result;
        }

        for (const chat of chats) {
            const chatId = chat.id?._serialized ?? null;
            const exists = chatId ? await this.hasExistingChatFolder(chatId) : false;
            if (!includeNewChats && (!chatId || !exists)) {
                result.skippedNewChats++;
                continue;
            }
            if (includeNewChats && chatId && !exists) result.newChatIds.push(chatId);
            result.chats.push(chat);
            onOpening?.(result.chats.length, chats.length, chat.name?.trim() || chatId || 'nieznany czat');
        }
        return result;
    }

    /** Otwiera czaty pojedynczo, po identyfikatorach. */
    private async openChatsById(
        ids: readonly string[],
        includeNewChats: boolean,
        result: BackfillChatList,
        onOpening?: (current: number, total: number, chat: string) => void,
    ): Promise<void> {
        const selected: string[] = [];
        // Ten sam czat bywa w spisie pod numerem i pod @lid. Otwieramy go raz,
        // zaczynając od numeru - dla niego WhatsApp częściej oddaje komplet danych.
        const seenFolders = new Set<string>();

        for (const chatId of [...ids].sort(phoneIdsFirst)) {
            const folder = this.index.get(chatId)?.safeName ?? null;
            if (folder && seenFolders.has(folder)) continue;

            const exists = await this.hasExistingChatFolder(chatId);
            if (!includeNewChats && !exists) {
                result.skippedNewChats++;
                continue;
            }
            if (includeNewChats && !exists) result.newChatIds.push(chatId);
            if (folder) seenFolders.add(folder);
            selected.push(chatId);
        }

        for (const [index, chatId] of selected.entries()) {
            try {
                const chat = await this.client.getChatById(chatId);
                if (chat) {
                    result.chats.push(chat);
                    onOpening?.(index + 1, selected.length, chat.name?.trim() || chatId);
                } else {
                    result.failedChats++;
                    onOpening?.(index + 1, selected.length, chatId);
                }
            } catch (err) {
                result.failedChats++;
                log.quiet(err, { stage: 'nadrabianie: pobranie czatu', chat: chatId });
                onOpening?.(index + 1, selected.length, chatId);
            }
        }
    }

    /** Czaty ze spisu archiwum. Relacje mają własny przegląd i tu nie należą. */
    private archivedChatIds(): string[] {
        return [...this.index.keys()].filter((id) => id.includes('@') && !isStatusChat(id));
    }

    /** Same ID czatów, bez zawodnej serializacji pełnych modeli. */
    private async rawChatIds(): Promise<string[] | null> {
        const page = this.client.pupPage;
        if (!page || typeof page.evaluate !== 'function') return null;

        try {
            const ids = await page.evaluate((): string[] | null => {
                /* eslint-disable @typescript-eslint/no-explicit-any */
                const root = globalThis as any;
                const store = root.window?.Store ?? root.Store;
                if (!store?.Chat?.getModelsArray) return null;

                return store.Chat.getModelsArray()
                    .map((chat: any) => chat?.id?._serialized)
                    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
                /* eslint-enable @typescript-eslint/no-explicit-any */
            });
            return ids ? [...new Set(ids)] : null;
        } catch (err) {
            log.quiet(err, { stage: 'nadrabianie: surowa lista ID czatów' });
            return null;
        }
    }

    /**
     * Czy czat ma już przypisany, faktycznie istniejący folder. Sam wpis w
     * _czaty.json nie wystarcza: folder mógł zostać ręcznie usunięty.
     * Uwzględniamy też stare archiwa nazwane samymi cyframi, sprzed spisu.
     */
    private async hasExistingChatFolder(chatId: string): Promise<boolean> {
        const known = this.index.get(chatId);
        if (
            known?.safeName &&
            (await pathExists(path.join(this.config.logsDir, known.safeName)))
        ) {
            return true;
        }

        return (await this.findLegacyFolder(chatId, chatId)) !== null;
    }

    private async quotedInfo(message: WaMessage): Promise<QuotedInfo | null> {
        if (!message.hasQuotedMsg) return null;
        try {
            const quoted = (await message.getQuotedMessage()) as WaMessage | null;
            if (!quoted) return null;

            let sender = 'Ja';
            if (!quoted.fromMe) {
                try {
                    sender =
                        contactDisplayName((await quoted.getContact()) as WaContact) ??
                        quoted.author ??
                        quoted.from ??
                        'Nieznany';
                } catch {
                    sender = quoted.author ?? quoted.from ?? 'Nieznany';
                }
            }
            return { sender, body: quoted.body || typeLabel(quoted.type) };
        } catch {
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Nazwa czatu i folder
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Czat założony pod cyframi z identyfikatora dostaje prawdziwą nazwę,
     * gdy tylko ją poznamy. Nazwa profilu z przychodzącej wiadomości nic nie
     * kosztuje, więc sprawdzamy ją zawsze; o kontakt i numer telefonu pytamy
     * rzadziej, bo to zapytania do przeglądarki.
     */
    private async maybeUpgradeName(message: WaMessage, state: ChatState, rawId: string): Promise<void> {
        if (Date.now() - state.nameRetryAt < NAME_RETRY_MS) return;
        state.nameRetryAt = Date.now();

        const identity = await this.identity.resolve(message, state.rawId ?? rawId);
        if (!identity) return;

        // Nazwa zapisanego kontaktu jest zmienną metadaną. Przyjmujemy lepszy
        // poziom nazwy, a na tym samym wiarygodnym poziomie także jej zmianę.
        const sameReliableTier =
            identity.tier === state.nameTier && identity.tier >= NameTier.NICK;
        if (
            identity.name !== state.name &&
            (identity.tier > state.nameTier || sameReliableTier)
        ) {
            await this.renameChat(state, identity.name, identity.tier);
        }
    }

    /**
     * Przenosi folder czatu pod nową nazwę i poprawia nagłówki w zapisanych
     * już plikach HTML. Odnośniki do mediów i zdjęć są względne, więc
     * przeprowadzka ich nie rusza. Gdy folder o nowej nazwie już istnieje,
     * nic nie ruszamy - scalanie dwóch archiwów to nie robota dla loggera.
     */
    private async renameChat(state: ChatState, newName: string, newTier: NameTier): Promise<void> {
        const safeName = this.folderFor(state.id, newName);
        const oldName = state.name;

        if (safeName !== state.safeName) {
            const newDir = path.join(this.config.logsDir, safeName);
            if (await pathExists(newDir)) {
                log.debug(
                    `Czat ${state.id} to "${newName}", ale folder ${safeName} już istnieje - zostaję w ${state.safeName}`,
                );
                return;
            }
            try {
                await move(state.chatDir, newDir);
            } catch (err) {
                log.error(`Nie udało się przenieść ${state.safeName} → ${safeName}`, err);
                return;
            }
            state.safeName = safeName;
            state.chatDir = newDir;
            state.mediaDir = path.join(newDir, 'media');
        }

        state.name = newName;
        state.nameTier = newTier;

        log.info(`Czat "${oldName}" jest teraz "${newName}".`);

        await this.retitleBatches(state, oldName, newName);
        await this.rememberChat(state);
        await this.saveState(state);
    }

    /** Podmiana nazwy czatu w nagłówkach zapisanych już partii HTML. */
    private async retitleBatches(state: ChatState, oldName: string, newName: string): Promise<void> {
        const swaps = titleSwaps(oldName, newName);
        const files = (await listDir(state.chatDir)).filter((f) => /^messages_\d+\.html$/.test(f));

        for (const file of files) {
            const full = path.join(state.chatDir, file);
            try {
                const before = await readText(full);
                if (before === null) continue;

                let html = before;
                for (const [from, to] of swaps) html = html.split(from).join(to);
                if (html !== before) await writeFileAtomic(full, html);
            } catch (err) {
                log.error(`Nie udało się poprawić nagłówka w ${file}`, err);
            }
        }
    }

    /**
     * Folder, w którym starsze wersje trzymały ten czat - nazwany samymi
     * cyframi z identyfikatora. Szukamy go tylko wtedy, gdy czatu nie ma
     * w spisie, żeby przy zmianie nazwy zabrać ze sobą to, co już zapisano.
     */
    private async findLegacyFolder(
        chatId: string,
        rawId: string | null,
    ): Promise<ChatIndexEntry | null> {
        for (const id of [bareId(chatId), rawId]) {
            if (!id) continue;

            const name = placeholderName(id);
            const safeName = this.folderFor(chatId, name);
            if (await pathExists(path.join(this.config.logsDir, safeName))) {
                return { name, safeName, tier: NameTier.ID };
            }
        }
        return null;
    }

    /** Nazwa folderu czatu. Relacje idą o poziom głębiej, do Statusy/. */
    private folderFor(chatId: string, chatName: string): string {
        const safe = safeFileName(chatName, bareId(chatId).replace(/[^a-zA-Z0-9_-]/g, '_'));
        return isStatusChat(chatId) ? `${STATUS_DIR}/${safe}` : safe;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Stan czatu
    // ─────────────────────────────────────────────────────────────────────

    private async initState(
        chatId: string,
        chatName: string,
        chatTier: NameTier,
        rawId: string | null,
    ): Promise<void> {
        // Archiwum tego czatu może już gdzieś leżeć - wtedy otwieramy je tam,
        // gdzie jest, choćby nazwa z tego uruchomienia była inna. Lepszą
        // nazwę wprowadzamy niżej, przenosinami, a nie drugim folderem.
        const aliasKey = isStatusChat(chatId) && rawId ? statusChatId(rawId) : rawId;
        const known = this.index.get(chatId) ?? (aliasKey ? this.index.get(aliasKey) : undefined);

        const knownFolderExists =
            known?.safeName !== undefined &&
            (await pathExists(path.join(this.config.logsDir, known.safeName)));

        // Spisu może nie być, a folder i tak leżeć na dysku - tak nazywały
        // czaty starsze wersje programu, samymi cyframi z identyfikatora.
        // Wchodzimy do niego, zamiast zostawiać w nim wiadomości sierotą.
        const legacy = knownFolderExists ? null : await this.findLegacyFolder(chatId, rawId);

        const adopted = knownFolderExists ? known : legacy;
        const useName = adopted ? adopted.name : chatName;
        const useTier = adopted ? (adopted.tier ?? NameTier.ID) : chatTier;
        const safeName = adopted ? adopted.safeName : this.folderFor(chatId, useName);

        const chatDir = path.join(this.config.logsDir, safeName);
        const mediaDir = path.join(chatDir, 'media');
        await ensureDir(chatDir);

        const saved = await readJson<ChatStateFile>(path.join(chatDir, '_state.json'));
        const seenIds = await this.loadRecentSeenIds(chatDir, saved);

        const state: ChatState = {
            id: chatId,
            name: useName,
            nameTier: useTier,
            isStatus: isStatusChat(chatId),
            safeName,
            chatDir,
            mediaDir,
            batchNum: saved?.batchNum ?? 1,
            totalMessages: saved?.totalMessages ?? 0,
            pending: Array.isArray(saved?.pendingMessages) ? saved.pendingMessages : [],
            seenIds,
            seenIdSet: new Set(seenIds),
            sync: saved?.sync ?? null,
            saveTimer: null,
            lastSaveAt: 0,
            rawId,
            // Nazwę właśnie ustaliliśmy - nie ma po co pytać drugi raz przy
            // tej samej wiadomości.
            nameRetryAt: Date.now(),
            lastAvatarPath: null,
            currentAvatar: saved?.avatar ?? null,
        };

        this.states.set(chatId, state);
        await this.rememberChat(state);

        // Nazwa z tego uruchomienia jest lepsza niż zapamiętana - przenosimy.
        // Gorszej nie przyjmujemy: raz zdobyty numer czy nazwisko nie ma
        // wracać do cyfr @lid tylko dlatego, że WhatsApp dziś ich nie podał.
        const sameReliableTier = chatTier === useTier && chatTier >= NameTier.NICK;
        if (chatName !== useName && (chatTier > useTier || sameReliableTier)) {
            await this.renameChat(state, chatName, chatTier);
        }
    }

    /**
     * Starsze stany przechowywały ID tylko dla relacji. Uzupełniamy pamięć
     * identyfikatorami z bieżącej partii oraz ostatnich zamkniętych partii,
     * żeby pierwsze nadrabianie po aktualizacji nie zrobiło kopii.
     */
    private async loadRecentSeenIds(
        chatDir: string,
        saved: ChatStateFile | null,
    ): Promise<string[]> {
        const ids: string[] = [];
        const known = new Set<string>();
        const add = (id: unknown): void => {
            if (typeof id !== 'string' || id.length === 0 || known.has(id)) return;
            known.add(id);
            ids.push(id);
        };

        const batchFiles = (await listDir(chatDir))
            .filter((file) => /^messages_\d+\.json$/.test(file))
            .sort()
            .reverse();

        const recentBatchIds: string[] = [];
        const recentBatchSet = new Set<string>();
        for (const file of batchFiles) {
            const batch = await readJson<BatchFile>(path.join(chatDir, file));
            for (const message of [...(batch?.messages ?? [])].reverse()) {
                const id = message?.id;
                if (typeof id !== 'string' || !id || recentBatchSet.has(id)) continue;
                recentBatchSet.add(id);
                recentBatchIds.push(id);
                if (recentBatchIds.length >= SEEN_ID_LIMIT) break;
            }
            if (recentBatchIds.length >= SEEN_ID_LIMIT) break;
        }
        for (const id of recentBatchIds.reverse()) add(id);
        for (const id of saved?.seenIds ?? []) add(id);
        for (const message of saved?.pendingMessages ?? []) add(message?.id);

        return ids.slice(-SEEN_ID_LIMIT);
    }

    /**
     * Zapis _state.json nie częściej niż co STATE_SAVE_INTERVAL_MS.
     * Chroni dysk przy ruchliwych grupach; partie HTML zapisują się niezależnie.
     */
    private async scheduleStateSave(state: ChatState): Promise<void> {
        const interval = this.config.stateSaveIntervalMs;
        const sinceLast = Date.now() - state.lastSaveAt;

        // Zapis natychmiastowy musi się zdążyć wykonać, zanim wrócimy -
        // inaczej mógłby się zderzyć z przenosinami folderu czatu.
        if (interval <= 0 || sinceLast >= interval) {
            await this.saveState(state);
            return;
        }
        if (state.saveTimer) return;

        state.saveTimer = setTimeout(() => {
            state.saveTimer = null;
            void this.enqueue(state.id, () => this.saveState(state));
        }, interval - sinceLast);

        // Oczekujący zapis nie może trzymać procesu przy życiu.
        state.saveTimer.unref?.();
    }

    private async saveState(state: ChatState): Promise<boolean> {
        if (state.saveTimer) {
            clearTimeout(state.saveTimer);
            state.saveTimer = null;
        }
        state.lastSaveAt = Date.now();

        const data: ChatStateFile = {
            chatName: state.name,
            nameTier: state.nameTier,
            avatar: state.currentAvatar,
            batchNum: state.batchNum,
            totalMessages: state.totalMessages,
            pendingMessages: state.pending,
            sync: state.sync,
            lastUpdated: new Date().toISOString(),
        };
        if (state.seenIds.length > 0) data.seenIds = state.seenIds;

        try {
            await writeJsonAtomic(path.join(state.chatDir, '_state.json'), data);
            return true;
        } catch (err) {
            log.error(`Nie udało się zapisać stanu czatu "${state.name}"`, err);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Partie HTML
    // ─────────────────────────────────────────────────────────────────────

    private async flushBatch(state: ChatState): Promise<void> {
        if (state.pending.length === 0) return;

        const fileName = batchFileName(state.batchNum);
        const html = generateHtml({
            chatName: state.name,
            batchNum: state.batchNum,
            messages: state.pending,
            // Ta partia jest w tej chwili najnowsza, więc odnośnik "dalej"
            // zostaje wyszarzony. Odblokujemy go przy zapisie kolejnej.
            isLatest: true,
            messagesPerFile: this.config.messagesPerFile,
            retentionNote: this.retentionNote(),
        });

        await writeFileAtomic(path.join(state.chatDir, fileName), html);

        // Obok pliku HTML zapisujemy tę samą partię w JSON-ie. HTML jest do
        // czytania, JSON do czytania maszynowo - panel nie musi rozbierać
        // gotowej strony na części, żeby dobrać się do wiadomości.
        await writeJsonAtomic(path.join(state.chatDir, batchDataName(state.batchNum)), {
            chatName: state.name,
            batchNum: state.batchNum,
            savedAt: new Date().toISOString(),
            messages: state.pending,
        } satisfies BatchFile);

        await this.unlockNextLink(state, state.batchNum - 1);

        log.debug(`Zapisano ${state.safeName}/${fileName} (${state.pending.length} wiadomości)`);

        state.batchNum++;
        state.pending = [];
        await this.saveState(state);
    }

    /**
     * W poprzednim pliku odnośnik "dalej" był wyszarzony, bo kolejnej części
     * jeszcze nie było. Teraz już jest, więc podmieniamy go na działający.
     */
    private async unlockNextLink(state: ChatState, batchNum: number): Promise<void> {
        if (batchNum < 1) return;

        const file = path.join(state.chatDir, batchFileName(batchNum));
        try {
            const html = await readText(file);
            if (html === null || !html.includes(NEXT_LINK_MARKER.open)) return;

            const pattern = new RegExp(
                `${NEXT_LINK_MARKER.open}[\\s\\S]*?${NEXT_LINK_MARKER.close}`,
                'g',
            );
            const replacement =
                NEXT_LINK_MARKER.open + buildNextLink(batchNum + 1) + NEXT_LINK_MARKER.close;

            await writeFileAtomic(file, html.replace(pattern, replacement));
        } catch (err) {
            log.error('Nie udało się odblokować odnośnika w poprzedniej części', err);
        }
    }

    private retentionNote(): string {
        return this.config.retentionEnabled && this.config.retentionDays > 0
            ? `Starsze pliki kasują się po ${this.config.retentionDays} dniach.`
            : 'Kasowanie starych plików jest wyłączone.';
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Skasowane wiadomości
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Wiadomość skasowana w WhatsAppie zostaje w archiwum, tyle że z notką.
     * Jeśli czeka jeszcze w partii - poprawiamy stan; jeśli trafiła już do
     * pliku HTML - dopisujemy notkę wprost w nim.
     */
    async markDeleted(message: WaMessage | null): Promise<boolean> {
        const msgId = messageKey(message);
        if (!msgId) return false;
        const detectedAt = new Date().toISOString();

        for (const [chatId, state] of this.states) {
            const pending = state.pending.find((m) => m.id === msgId);
            if (!pending) continue;

            let changed = false;
            await this.enqueue(chatId, async () => {
                if (pending.isDeleted) return;
                pending.isDeleted = true;
                pending.deletedAt = detectedAt;
                changed = true;
                await this.saveState(state);
                await this.db?.saveMessage(toMessageRow(pending, state.id, state.safeName));
            });
            if (changed) {
                log.info(`[skasowana - zachowana] ${pending.from}: ${pending.body.slice(0, 60)}`);
            }
            return changed;
        }

        await this.db?.markDeleted(msgId, detectedAt);

        const patched = await this.patchDeletedInFiles(message, msgId, detectedAt);
        if (!patched) await this.logDeletedId(msgId);
        return patched;
    }

    /** Szuka wiadomości w zapisanych JSON/HTML i oznacza ją w obu formatach. */
    private async patchDeletedInFiles(
        message: WaMessage | null,
        msgId: string,
        detectedAt: string,
    ): Promise<boolean> {
        const rawId = chatIdOf(message);
        const chatId = rawId ? (this.aliases.get(rawId) ?? rawId) : null;
        const state = chatId ? this.states.get(chatId) : null;

        // Stan nie musi być jeszcze otwarty w tej sesji. Spis po stabilnym ID
        // pozwala wskazać dokładnie jeden folder bez skanowania całego logs/.
        const known = chatId ? (this.index.get(chatId) ?? (rawId ? this.index.get(rawId) : undefined)) : undefined;
        const dir = state?.chatDir ??
            (known?.safeName ? path.join(this.config.logsDir, known.safeName) : null);
        const dirs = dir ? [dir] : [];
        for (const dir of dirs) {
            const jsonFiles = (await listDir(dir))
                .filter((f) => /^messages_\d+\.json$/.test(f))
                .sort()
                .reverse();

            for (const file of jsonFiles) {
                const full = path.join(dir, file);
                const batch = await readJson<BatchFile>(full);
                const archived = batch?.messages?.find((entry) => entry.id === msgId);
                if (!batch || !archived) continue;

                if (!archived.isDeleted) {
                    archived.isDeleted = true;
                    archived.deletedAt = detectedAt;
                    await writeJsonAtomic(full, batch);
                }

                const batchNumber = Number.parseInt(/(\d+)/.exec(file)?.[1] ?? '', 10);
                const htmlFile = Number.isFinite(batchNumber)
                    ? path.join(dir, batchFileName(batchNumber))
                    : null;
                if (htmlFile) {
                    const html = await readText(htmlFile);
                    const patchedHtml = html === null ? null : markDeletedInHtml(html, msgId);
                    if (patchedHtml !== null) await writeFileAtomic(htmlFile, patchedHtml);
                }
                log.info(`[skasowana - zachowana] oznaczono w ${path.basename(dir)}/${file}`);
                return true;
            }

            // Bardzo stare archiwum może mieć tylko HTML, bez sąsiedniego JSON.
            const htmlFiles = (await listDir(dir))
                .filter((f) => /^messages_\d+\.html$/.test(f))
                .sort()
                .reverse();
            for (const file of htmlFiles) {
                const full = path.join(dir, file);
                const html = await readText(full);
                const patchedHtml = html === null ? null : markDeletedInHtml(html, msgId);
                if (patchedHtml === null) continue;
                await writeFileAtomic(full, patchedHtml);
                return true;
            }
        }
        return false;
    }

    private async logDeletedId(msgId: string): Promise<void> {
        try {
            await ensureDir(this.config.logsDir);
            await fs.appendFile(
                path.join(this.config.logsDir, '_skasowane.log'),
                `${new Date().toISOString()} ${msgId}\n`,
                'utf8',
            );
        } catch {
            // Sam identyfikator to tylko ślad diagnostyczny.
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Relacje
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Dociąga relacje, które WhatsApp ma jeszcze u siebie, a których nie ma
     * w archiwum - te z czasu, gdy program był wyłączony. Relacja żyje dobę,
     * więc co przepadło, to przepadło; bierzemy wszystko, co widać.
     */
    async sweepStatuses(): Promise<StatusSweepStats> {
        const stats: StatusSweepStats = { saved: 0, skipped: 0 };
        if (!this.config.saveStatuses) return stats;
        if (typeof this.client.getBroadcasts !== 'function') return stats;

        let broadcasts;
        try {
            broadcasts = (await this.client.getBroadcasts()) ?? [];
        } catch (err) {
            log.error('Nie udało się pobrać listy relacji', err, { stage: 'getBroadcasts' });
            return stats;
        }

        for (const broadcast of broadcasts) {
            for (const raw of broadcast?.msgs ?? []) {
                const message = raw as WaMessage;
                if (this.statusAlreadySaved(message)) {
                    stats.skipped++;
                    continue;
                }
                try {
                    if (await this.save(message, { forceStatus: true })) stats.saved++;
                    else stats.skipped++;
                } catch (err) {
                    log.quiet(err, {
                        stage: 'relacja z przeglądu',
                        messageId: messageKey(message),
                    });
                }
            }
        }
        return stats;
    }

    /**
     * Czy tę relację mamy już w archiwum. Patrzymy na stan w pamięci, a gdy
     * czat nie jest jeszcze otwarty - wprost w jego _state.json na dysku.
     */
    private statusAlreadySaved(message: WaMessage): boolean {
        const author = statusAuthorId(message);
        const msgId = messageKey(message);
        if (!author || !msgId) return false;

        const chatId = statusChatId(author);
        const state = this.states.get(chatId);
        if (state) return state.seenIds.includes(msgId);

        const known = this.index.get(chatId);
        if (!known?.safeName) return false;

        const saved = readJsonSync<ChatStateFile>(
            path.join(this.config.logsDir, known.safeName, '_state.json'),
        );
        return Array.isArray(saved?.seenIds) && saved.seenIds.includes(msgId);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Zdjęcia profilowe
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Przegląd zdjęć profilowych. Identyfikatory bierzemy ze spisu czatów,
     * po jednym na folder - numer telefonu ma pierwszeństwo przed @lid,
     * bo serwer częściej oddaje dla niego zdjęcie.
     */
    async refreshAvatars(): Promise<{ checked: number; changed: number }> {
        const perFolder = new Map<string, string>();

        for (const [key, entry] of this.index) {
            const id = bareId(key);
            if (!id || id === 'me') continue;

            const current = perFolder.get(entry.safeName);
            if (!current || (current.endsWith('@lid') && !id.endsWith('@lid'))) {
                perFolder.set(entry.safeName, id);
            }
        }
        const stats = await this.avatars.refreshAll(perFolder.values());

        // Nowa wersja ma od razu trafić na listę rozmów, także gdy w czacie
        // nie przyszła właśnie żadna wiadomość.
        for (const state of this.states.values()) {
            const candidates = [state.id, state.rawId].filter(
                (id, index, all): id is string => Boolean(id) && all.indexOf(id) === index,
            );
            let current: string | null = null;
            for (const id of candidates) {
                current = this.avatars.cachedPathFor(id, state.chatDir);
                if (current) break;
            }
            if (!current || current === state.currentAvatar) continue;

            state.currentAvatar = current;
            await this.saveState(state);
            await this.db?.setChatAvatar(
                state.id,
                toDatabaseArchivePath(state.safeName, current),
            );
        }
        return stats;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Kasowanie starych wiadomości oczekujących
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Wyrzuca z bieżących partii wiadomości starsze niż podana liczba dni.
     * Bez tego w cichym czacie wiadomość mogłaby czekać w _state.json latami.
     */
    async pruneOldPending(days: number): Promise<number> {
        if (!days || days <= 0) return 0;

        const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
        let removed = 0;
        const handled = new Set<string>();

        for (const [chatId, state] of [...this.states]) {
            await this.enqueue(chatId, async () => {
                handled.add(path.resolve(state.chatDir, '_state.json').toLowerCase());

                const before = state.pending.length;
                state.pending = state.pending.filter((m) => m.timestamp >= cutoff);
                const diff = before - state.pending.length;
                if (diff > 0) {
                    removed += diff;
                    await this.saveState(state);
                }
            });
        }

        // Ciche czaty nie mają stanu w pamięci, dopóki nie przyjdzie w nich
        // wiadomość. Przeglądamy więc również _state.json na dysku, inaczej
        // oczekujące wpisy omijałyby kasowanie bez końca.
        for (const file of await this.stateFilesOnDisk()) {
            if (handled.has(path.resolve(file).toLowerCase())) continue;

            const saved = await readJson<ChatStateFile>(file);
            if (!Array.isArray(saved?.pendingMessages)) continue;

            const before = saved.pendingMessages.length;
            saved.pendingMessages = saved.pendingMessages.filter((m) => m.timestamp >= cutoff);
            const diff = before - saved.pendingMessages.length;
            if (diff === 0) continue;

            removed += diff;
            saved.lastUpdated = new Date().toISOString();
            try {
                await writeJsonAtomic(file, saved);
            } catch (err) {
                log.quiet(err, { stage: `kasowanie oczekujących (${file})` });
            }
        }

        // W bazie kasujemy po tym samym terminie, co pliki na dysku -
        // inaczej panel pokazywałby rozmowy, których w archiwum już nie ma.
        const fromDb = (await this.db?.deleteOlderThan(cutoff)) ?? 0;
        if (fromDb > 0) log.info(`[Kasowanie] usunięto z bazy ${fromDb} wiadomości`);

        if (removed > 0) {
            log.info(`[Kasowanie] usunięto ${removed} oczekujących wiadomości starszych niż ${days} dni`);
        }
        return removed;
    }

    /** Pliki stanu zwykłych czatów oraz Statusy/<autor>. */
    private async stateFilesOnDisk(): Promise<string[]> {
        const files: string[] = [];

        for (const entry of await listDirents(this.config.logsDir)) {
            if (!entry.isDirectory() || entry.name === '_avatars' || entry.name === '_tau') continue;

            const dir = path.join(this.config.logsDir, entry.name);
            const direct = path.join(dir, '_state.json');
            if (await pathExists(direct)) files.push(direct);

            if (entry.name !== STATUS_DIR) continue;
            for (const author of await listDirents(dir)) {
                if (!author.isDirectory()) continue;
                const nested = path.join(dir, author.name, '_state.json');
                if (await pathExists(nested)) files.push(nested);
            }
        }
        return files;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Zamykanie
    // ─────────────────────────────────────────────────────────────────────

    /** Zrzuca na dysk wszystko, co czeka w pamięci. Wołane przy zamykaniu. */
    async flushAll(): Promise<void> {
        for (const [chatId, state] of [...this.states]) {
            await this.enqueue(chatId, async () => {
                await this.flushBatch(state);
                // Czat bez oczekujących wiadomości też ma co zapisać -
                // choćby listę już zarchiwizowanych relacji.
                await this.saveState(state);
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Spis czatów i kolejka
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Zapamiętuje, pod jaką nazwą i w którym folderze siedzi czat. Wpis idzie
     * też pod identyfikatorem z wiadomości (@lid): przy kolejnym uruchomieniu
     * WhatsApp może rozwikłać go na numer, a wtedy klucz jest już inny
     * i bez tego drugiego wpisu archiwum rozjechałoby się na dwa foldery.
     */
    private async rememberChat(state: ChatState): Promise<void> {
        const entry: ChatIndexEntry = {
            name: state.name,
            safeName: state.safeName,
            tier: state.nameTier,
        };

        const aliasKey =
            state.rawId && state.rawId !== state.id
                ? state.isStatus
                    ? statusChatId(state.rawId)
                    : state.rawId
                : null;
        const keys = aliasKey ? [state.id, aliasKey] : [state.id];

        const changed = keys.some((key) => {
            const known = this.index.get(key);
            return (
                !known ||
                known.name !== entry.name ||
                known.safeName !== entry.safeName ||
                known.tier !== entry.tier
            );
        });
        if (!changed) return;

        for (const key of keys) this.index.set(key, entry);
        try {
            await writeJsonAtomic(this.indexFile, Object.fromEntries(this.index));
        } catch (err) {
            log.error('Nie udało się zapisać spisu czatów', err);
        }

        await this.db?.saveChat({
            id: state.id,
            name: state.name,
            nameTier: state.nameTier,
            folder: state.safeName,
            isStatus: state.isStatus,
            isGroup: state.id.endsWith('@g.us'),
        });
    }

    private loadIndex(): void {
        const saved = readJsonSync<Record<string, ChatIndexEntry>>(this.indexFile);
        for (const [id, entry] of Object.entries(saved ?? {})) {
            if (entry?.safeName) {
                this.index.set(id, { ...entry, tier: entry.tier ?? NameTier.ID });
            }
        }
    }

    /**
     * Dokleja zadanie do łańcucha promisów danego czatu. Dwie wiadomości
     * z tego samego czatu nigdy nie wykonują się równolegle, więc nie ma
     * wyścigu ani przy tworzeniu stanu, ani przy zapisie plików.
     */
    private enqueue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(chatId) ?? Promise.resolve();
        const next = previous.then(task, task);
        this.queues.set(
            chatId,
            next.catch(() => undefined),
        );
        return next;
    }

    /**
     * Po zsynchronizowaniu WhatsAppa pytamy o kontakty jeszcze raz. Nazwy
     * ustalone przed synchronizacją bywały prowizorką - numerem zamiast
     * nazwiska - i nie ma powodu, żeby taka została na stałe.
     */
    refreshAfterSync(): void {
        this.identity.refreshAfterSync();
        for (const state of this.states.values()) state.nameRetryAt = 0;
    }
}

/** Numery przed @lid - dla numeru WhatsApp częściej oddaje komplet danych. */
function phoneIdsFirst(a: string, b: string): number {
    const rank = (id: string): number => (id.endsWith('@lid') ? 1 : 0);
    return rank(a) - rank(b);
}

function containsCheckpoint(messages: readonly WaMessage[], checkpoint: SyncCheckpoint): boolean {
    return messages.some((message) => messageKey(message) === checkpoint.messageId);
}

function oldestTimestamp(messages: readonly WaMessage[]): number {
    let oldest = Number.POSITIVE_INFINITY;
    for (const message of messages) oldest = Math.min(oldest, message.timestamp);
    return oldest;
}

function isAfterCheckpoint(message: WaMessage, checkpoint: SyncCheckpoint): boolean {
    if (message.timestamp > checkpoint.timestamp) return true;
    if (message.timestamp < checkpoint.timestamp) return false;
    return messageKey(message) !== checkpoint.messageId;
}

function lastByTimestamp(messages: readonly ArchivedMessage[]): ArchivedMessage | null {
    let latest: ArchivedMessage | null = null;
    for (const message of messages) {
        if (!latest || message.timestamp > latest.timestamp) latest = message;
    }
    return latest;
}

/** Taki sam krótki podgląd wiadomości, jaki pokazywała wersja sprzed przepisania. */
export function formatMessageLine(
    chatName: string,
    message: Pick<ArchivedMessage, 'timestamp' | 'body' | 'type' | 'from' | 'fromMe'>,
    isLocked = false,
): string {
    const preview = (message.body.replace(/\s+/g, ' ').trim() || `[${message.type}]`).slice(0, 60);
    const label = isLocked ? `${chatName} 🔒` : chatName;
    const time = new Date(message.timestamp * 1000);
    const clock = [time.getHours(), time.getMinutes(), time.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
    return `[${clock}] [${label}] ${message.fromMe ? '→' : '←'} ${message.from}: ${preview}`;
}

/**
 * WhatsApp prawie zawsze daje własne, stabilne ID. Awaryjny identyfikator
 * przypomina datę z sześcioma cyframi, ale cyfry wynikają z treści zamiast
 * być losowe - ta sama wiadomość musi dostać to samo ID po restarcie.
 */
export function archiveMessageId(message: WaMessage, chatId: string): string {
    const native = messageKey(message);
    if (native) return native;

    const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : 0;
    const date = new Date(timestamp * 1000);
    const stamp = [
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
        date.getUTCMilliseconds(),
    ]
        .map((part, index) => String(part).padStart(index === 0 ? 4 : index === 6 ? 3 : 2, '0'))
        .join('');
    const fingerprint = JSON.stringify([
        chatId,
        timestamp,
        message.from ?? null,
        message.to ?? null,
        message.author ?? null,
        message.fromMe,
        message.type,
        message.body,
        message._data?.filename ?? null,
    ]);
    const digest = createHash('sha256').update(fingerprint).digest('hex').slice(0, 12);
    const digits = (BigInt(`0x${digest}`) % 1_000_000n).toString().padStart(6, '0');
    return `local-${stamp}-${digits}`;
}

// ── Wiadomości bez treści tekstowej ─────────────────────────────────────

function locationInfo(message: WaMessage): LocationInfo | null {
    if (message.type !== 'location' || !message.location) return null;
    const loc = message.location;
    return {
        latitude: Number(loc.latitude),
        longitude: Number(loc.longitude),
        name: loc.name ?? null,
        address: loc.address ?? null,
    };
}

function vCardInfo(message: WaMessage): VCardInfo[] | null {
    const cards = message.vCards;
    if (!Array.isArray(cards) || cards.length === 0) return null;

    return cards.map((rawCard) => {
        const text = String(rawCard ?? '');
        return {
            name: /^FN[^:]*:(.+)$/im.exec(text)?.[1]?.trim() ?? null,
            numbers: [...text.matchAll(/^TEL[^:]*:(.+)$/gim)]
                .map((m) => m[1]?.trim() ?? '')
                .filter(Boolean),
            org: /^ORG[^:]*:(.+)$/im.exec(text)?.[1]?.trim() ?? null,
        };
    });
}

function pollInfo(message: WaMessage): PollInfo | null {
    if (message.type !== 'poll_creation') return null;

    const options = Array.isArray(message.pollOptions)
        ? message.pollOptions
              .map((o) => (typeof o === 'string' ? o : (o as { name?: string })?.name))
              .filter((o): o is string => Boolean(o))
        : [];

    return {
        question: message.pollName ?? null,
        options,
        multiple: message.allowMultipleAnswers === true,
    };
}

async function readText(file: string): Promise<string | null> {
    try {
        return await fs.readFile(file, 'utf8');
    } catch {
        return null;
    }
}
