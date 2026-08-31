// Pliki, których nie udało się pobrać za pierwszym razem.
//
// WhatsApp odmawia wydania pliku z powodów, które za godzinę mogą już nie
// obowiązywać: media wygasły na serwerze i czekają na ponowne wysłanie przez
// telefon, telefon był akurat offline, łącze przycięło pobieranie w połowie.
// Do tej pory taka wiadomość zostawała w archiwum z notatką "nie udało się
// pobrać pliku" i nikt już nigdy do niej nie wracał - nadrabianie widziało
// znajome ID i pomijało ją jako zapisaną.
//
// Kolejka zapamiętuje takie wiadomości na dysku i wraca do nich przy każdym
// przeglądzie, dopóki plik się nie znajdzie albo nie skończą się podejścia.

import path from 'node:path';
import { readJson, writeJsonAtomic } from './util';

/** Ile razy wracamy do jednego pliku, zanim uznamy go za stracony. */
const MAX_ATTEMPTS = 8;

/** Po tylu dniach plik na pewno wygasł po stronie WhatsAppa. */
const MAX_AGE_DAYS = 14;

/** Nazwa pliku kolejki w folderze archiwum. */
export const MEDIA_QUEUE_FILE = '_media_do_pobrania.json';

export interface PendingMedia {
    /** Klucz archiwum czatu, ten sam co w _czaty.json. */
    chatId: string;
    /** Identyfikator wiadomości - taki, jakim posługuje się WhatsApp. */
    messageId: string;
    type: string;
    /** Powód pierwszej porażki, do diagnostyki. */
    reason: string;
    addedAt: string;
    attempts: number;
    lastTryAt: string | null;
}

/**
 * Kolejka trzymana w logs/_media_do_pobrania.json. Czytanie jest leniwe:
 * dopóki nic nie zawiedzie, plik nie musi nawet istnieć.
 */
export class MediaRetryQueue {
    private readonly file: string;
    private entries: PendingMedia[] | null = null;
    /** Zapis jest wspólny dla wielu wywołań - trzymamy je w jednej kolejce. */
    private writing: Promise<void> = Promise.resolve();

    constructor(logsDir: string) {
        this.file = path.join(logsDir, MEDIA_QUEUE_FILE);
    }

    /**
     * Dopisuje wiadomość do ponowienia. Ta sama wiadomość dwa razy w kolejce
     * nie ląduje - nadrabianie potrafi podać ją ponownie.
     */
    async add(entry: Omit<PendingMedia, 'addedAt' | 'attempts' | 'lastTryAt'>): Promise<void> {
        const entries = await this.load();
        if (entries.some((item) => item.messageId === entry.messageId)) return;

        entries.push({ ...entry, addedAt: new Date().toISOString(), attempts: 0, lastTryAt: null });
        await this.flush();
    }

    /** Wiadomości warte kolejnego podejścia, od najdawniej czekających. */
    async due(limit: number): Promise<PendingMedia[]> {
        const entries = await this.load();
        const deadline = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

        return entries
            .filter((entry) => entry.attempts < MAX_ATTEMPTS && addedAtMs(entry) > deadline)
            .sort((a, b) => addedAtMs(a) - addedAtMs(b))
            .slice(0, Math.max(0, limit));
    }

    /** Plik się znalazł albo nie ma po co dalej próbować. */
    async remove(messageId: string): Promise<void> {
        const entries = await this.load();
        const kept = entries.filter((entry) => entry.messageId !== messageId);
        if (kept.length === entries.length) return;

        this.entries = kept;
        await this.flush();
    }

    /** Odnotowuje nieudane podejście. */
    async markAttempt(messageId: string): Promise<void> {
        const entries = await this.load();
        const entry = entries.find((item) => item.messageId === messageId);
        if (!entry) return;

        entry.attempts++;
        entry.lastTryAt = new Date().toISOString();
        await this.flush();
    }

    /** Usuwa wpisy, do których i tak już nie wrócimy. */
    async prune(): Promise<number> {
        const entries = await this.load();
        const deadline = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        const kept = entries.filter(
            (entry) => entry.attempts < MAX_ATTEMPTS && addedAtMs(entry) > deadline,
        );

        const dropped = entries.length - kept.length;
        if (dropped === 0) return 0;

        this.entries = kept;
        await this.flush();
        return dropped;
    }

    /** Ile wiadomości czeka jeszcze na plik. */
    async size(): Promise<number> {
        return (await this.load()).length;
    }

    private async load(): Promise<PendingMedia[]> {
        if (this.entries) return this.entries;

        const saved = await readJson<unknown>(this.file);
        this.entries = Array.isArray(saved) ? saved.filter(isPendingMedia) : [];
        return this.entries;
    }

    private async flush(): Promise<void> {
        const entries = this.entries ?? [];
        this.writing = this.writing
            .catch(() => undefined)
            .then(() => writeJsonAtomic(this.file, entries));
        await this.writing;
    }
}

function addedAtMs(entry: PendingMedia): number {
    const value = Date.parse(entry.addedAt);
    return Number.isFinite(value) ? value : 0;
}

function isPendingMedia(value: unknown): value is PendingMedia {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Partial<PendingMedia>;
    return typeof entry.chatId === 'string' && typeof entry.messageId === 'string';
}
