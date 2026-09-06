// Oficjalny czat WhatsAppa (PSA) zawsze pomijamy. Rozmowę z numerem
// ChatGPT można archiwizować przez SAVE_AI_CHAT=true, a rozmowę z samym sobą
// wyłączyć przez SAVE_SELF_CHAT=false. Nazwa kontaktu ani autor wiadomości
// w grupie nie decydują o wykluczeniu całej rozmowy.

import type { Config } from './config';
import { chatIdOf, IdentityResolver, messageKey, NAME_RETRY_MS, readContact } from './identity';
import { bareId, isStatusMessage, statusAuthorId } from './statuses';
import type { ChatIndexEntry, WaMessage } from './types';

/** Identyfikatory telefoniczne; cyfry w @lid nie są numerem telefonu. */
export function isIgnoredChatId(id: string | null | undefined, saveAiChat = false): boolean {
    if (!id) return false;
    const match = /^(0|18002428478)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/i.exec(bareId(id));
    return match !== null && (match[1] === '0' || !saveAiChat);
}

/**
 * Czat "wiadomości do siebie" - ten, który WhatsApp podpisuje "(Ty)".
 * Rozmówcą jest tam własny numer, więc wystarczy porównać same cyfry.
 * Grupy, kanały i relacje odpadają na domenie identyfikatora.
 */
export function isSelfChatId(id: string | null | undefined, ownPhone: string | null): boolean {
    if (!id || !ownPhone) return false;
    const match = /^(\d+)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(bareId(id));
    return match?.[1] === ownPhone;
}

export class IgnoredChats {
    private readonly ids = new Set<string>();
    private readonly folders = new Set<string>();
    private readonly checkedAt = new Map<string, number>();
    private readonly checking = new Map<string, Promise<boolean>>();

    constructor(
        private readonly config: Pick<Config, 'saveAiChat' | 'saveSelfChat'>,
        private readonly identity: IdentityResolver,
        private readonly index: ReadonlyMap<string, ChatIndexEntry>,
    ) {
        // Starsze archiwum może znać ten sam czat pod numerem i pod @lid.
        // Nie usuwamy jego danych, ale żaden alias nie może wznowić pobierania.
        //
        // Własnego numeru jeszcze tu nie ma: archiwum powstaje przed
        // zalogowaniem do WhatsAppa. Czat z samym sobą rozpoznaje więc
        // dopiero isKnown(), przy pierwszej jego wiadomości.
        for (const [id, entry] of index) {
            if (isIgnoredChatId(id, config.saveAiChat)) this.folders.add(entry.safeName);
        }
    }

    isKnown(id: string | null | undefined): boolean {
        if (!id) return false;
        const folder = this.index.get(id)?.safeName;
        return this.isIgnoredId(id) || this.ids.has(bareId(id)) ||
            (folder !== undefined && this.folders.has(folder));
    }

    /** Wykluczenie widoczne po samym identyfikatorze, bez pytania przeglądarki. */
    private isIgnoredId(id: string | null | undefined): boolean {
        return isIgnoredChatId(id, this.config.saveAiChat) ||
            isSelfChatId(id, this.config.saveSelfChat ? null : this.identity.ownPhone());
    }

    /** To samo wykluczenie, gdy z @lid udało się wyłuskać sam numer. */
    private isIgnoredPhone(phone: string | null | undefined): boolean {
        return this.isIgnoredId(phone ? `${phone}@c.us` : null);
    }

    async has(id: string | null | undefined, message?: WaMessage): Promise<boolean> {
        if (!id) return false;
        if (this.isKnown(id)) return true;
        const baseId = bareId(id);
        if (!baseId.endsWith('@lid')) return false;

        // Nieznany LID nie może dodawać zapytania do przeglądarki przy
        // każdej wiadomości z wielotysięcznej historii. Kontakt wiadomości
        // jest dodatkowym źródłem, więc dostaje osobną próbę po samej liście.
        const key = message && !message.fromMe ? `message:${baseId}` : baseId;
        const checkedAt = this.checkedAt.get(key);
        if (checkedAt !== undefined && Date.now() - checkedAt < NAME_RETRY_MS) return false;
        const running = this.checking.get(key);
        if (running) return running;

        const check = this.checkLid(id, message);
        this.checking.set(key, check);
        try {
            const ignored = await check;
            if (!ignored) this.checkedAt.set(key, Date.now());
            return ignored;
        } finally {
            this.checking.delete(key);
        }
    }

    /** Synchronizacja mogła właśnie dostarczyć brakujące numery. */
    refreshAfterSync(): void {
        this.checkedAt.clear();
    }

    private async checkLid(id: string, message?: WaMessage): Promise<boolean> {
        const baseId = bareId(id);
        const phone = await this.identity.phoneForLid(baseId);
        let ignored = this.isIgnoredPhone(phone);
        if (!phone) {
            const info = await this.identity.contactInfo(baseId);
            ignored = this.isIgnoredPhone(info?.number);
            // Przy niepełnym Store numer czasem ma dopiero kontakt wiadomości.
            // getContact() wiadomości wysłanej wskazuje nas, a nie odbiorcę.
            if (!ignored && message && !message.fromMe) {
                try {
                    const contact = await message.getContact();
                    const number = contact ? readContact(contact, baseId).number : null;
                    ignored = this.isIgnoredPhone(number);
                } catch {
                    // Brak numeru nie jest dowodem, że należy pominąć rozmowę.
                }
            }
        }
        if (ignored) {
            this.ids.add(baseId);
            const folder = this.index.get(id)?.safeName;
            if (folder) this.folders.add(folder);
        }
        return ignored || this.isKnown(id);
    }

    async hasMessage(message: WaMessage | null, forceStatus = false): Promise<boolean> {
        if (!message) return false;
        if (forceStatus || isStatusMessage(message)) {
            return this.has(statusAuthorId(message), message);
        }

        const remote = (message.id as { remote?: unknown } | undefined)?.remote;
        const remoteId = typeof remote === 'string' ? remote :
            remote && typeof remote === 'object' && '_serialized' in remote ?
                String(remote._serialized ?? '') : null;
        const ids = new Set([chatIdOf(message), remoteId]);
        // Zdarzenie usunięcia może mieć już tylko pełny klucz wiadomości.
        if (![...ids].some(Boolean)) {
            ids.add(/^(?:true|false)_([^_]+@[^_]+)_/.exec(messageKey(message) ?? '')?.[1] ?? null);
        }
        if ([...ids].some((id) => this.isKnown(id))) return true;
        for (const id of ids) {
            if (await this.has(id, message)) return true;
        }
        return false;
    }
}
