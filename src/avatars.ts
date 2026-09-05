// Zdjęcia profilowe rozmówców, z historią.
//
// Każda wersja zostaje na dysku osobno, w logs/_avatars/<kontakt>/<data>.jpg.
// Dzięki temu stary plik HTML pokazuje to zdjęcie, które ten człowiek miał
// wtedy, a nie dzisiejsze. Zdjęcia nie podlegają kasowaniu po czasie.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config';
import { fetchBuffer } from './http';
import { log } from './log';
import type { AvatarRecord, AvatarVersion, WaClient, WaContact, WaMessage } from './types';
import { ensureDir, listDir, readJsonSync, toPosixPath, writeJsonAtomic } from './util';
import { readProfilePicUrl } from './waClient';

/**
 * Zdjęcie profilowe to miniatura, kilkadziesiąt kB. Limit jest tylko po to,
 * żeby nieoczekiwanie duża odpowiedź nie wjechała w całości do pamięci -
 * z limitem mediów z wiadomości nie ma nic wspólnego.
 */
const MAX_AVATAR_MB = 5;

/**
 * Nieudaną próbę (brak zdjęcia, ukryta prywatność, błąd sieci) ponawiamy
 * dopiero po tylu godzinach. Inaczej albo pytamy przy każdej wiadomości,
 * albo - jak w poprzedniej wersji - nie pytamy już nigdy.
 */
const RETRY_HOURS = 6;

/** Jeden przegląd nie może zamienić się w tysiące zapytań do WhatsAppa. */
const MAX_REFRESH_PER_SWEEP = 50;

export interface RefreshStats {
    checked: number;
    changed: number;
}

export class AvatarStore {
    private readonly dir: string;
    private readonly historyFile: string;
    private readonly history = new Map<string, AvatarRecord>();

    constructor(
        private readonly config: Config,
        private readonly client: WaClient,
    ) {
        this.dir = path.join(config.logsDir, '_avatars');
        this.historyFile = path.join(this.dir, '_historia.json');
        this.load();
    }

    /**
     * Ścieżka do zdjęcia nadawcy, widziana z folderu czatu. Zwraca to,
     * co już mamy - odświeżaniem zajmuje się przegląd co AVATAR_REFRESH_DAYS,
     * a nie każda przychodząca wiadomość.
     */
    async pathFor(
        contact: WaContact | null,
        message: WaMessage | null,
        chatDir: string,
    ): Promise<string | null> {
        if (!this.config.saveProfilePics) return null;

        const id = avatarIdOf(contact, message);
        if (!id) return null;

        const latest = this.latest(id);
        if (latest) return this.relativePath(latest, chatDir);

        const record = this.history.get(id);
        if (record?.checkedAt && Date.now() - Date.parse(record.checkedAt) < RETRY_HOURS * 3600 * 1000) {
            return null;
        }

        const version = await this.fetchVersion(id, contact);
        return version ? this.relativePath(version, chatDir) : null;
    }

    /**
     * Przegląd znanych rozmówców i grup. Zdjęcie starsze niż
     * AVATAR_REFRESH_DAYS sprawdzamy ponownie i, jeśli się zmieniło,
     * dokładamy nową wersję. Termin liczymy z daty zapisanej na dysku,
     * więc po dłuższym postoju maszyny zaległe nadrabiamy od razu.
     */
    async refreshAll(
        candidateIds: Iterable<string>,
        shouldSkip?: (id: string) => Promise<boolean>,
    ): Promise<RefreshStats> {
        const stats: RefreshStats = { checked: 0, changed: 0 };
        if (!this.config.saveProfilePics) return stats;

        const deadline = Date.now() - this.config.avatarRefreshDays * 24 * 60 * 60 * 1000;
        const targets = [...new Set<string>([...candidateIds, ...this.history.keys()])]
            .filter((id) => id && id !== 'me')
            .filter((id) => {
                const value = checkedAt(this.history.get(id));
                return value === 0 || value <= deadline;
            })
            .sort((a, b) => checkedAt(this.history.get(a)) - checkedAt(this.history.get(b)));

        for (const id of targets) {
            if (stats.checked >= MAX_REFRESH_PER_SWEEP) break;
            // Historia zdjęć zawiera też kontakty spoza bieżącej listy czatów.
            if (await shouldSkip?.(id)) continue;
            const record = this.history.get(id);
            if (record?.checkedAt && Date.parse(record.checkedAt) > deadline) continue;

            const before = this.latest(id)?.sha ?? null;

            let contact: WaContact | null = null;
            try {
                contact = (await this.client.getContactById(id)) as WaContact;
            } catch {
                // Grupa albo identyfikator, którego WhatsApp nie zna -
                // zdjęcia i tak spróbujemy pobrać po samym identyfikatorze.
            }

            await this.fetchVersion(id, contact);
            stats.checked++;
            if ((this.latest(id)?.sha ?? null) !== before) stats.changed++;
        }

        return stats;
    }

    /** Bieżąca lokalna wersja bez kontaktowania się z WhatsAppem. */
    cachedPathFor(id: string, chatDir: string): string | null {
        const latest = this.latest(id);
        return latest ? this.relativePath(latest, chatDir) : null;
    }

    // -- Pobieranie -------------------------------------------------------

    /**
     * Pyta WhatsAppa o zdjęcie i zapisuje je jako nową wersję, o ile różni
     * się od poprzedniej. Zwraca wersję do wstawienia w archiwum - także
     * tę poprzednią, gdy zdjęcie się nie zmieniło.
     */
    private async fetchVersion(id: string, contact: WaContact | null): Promise<AvatarVersion | null> {
        const previous = this.latest(id);

        try {
            const url = await this.profilePicUrl(id, contact);
            if (!url) {
                // Dwa różne powody, a w archiwum wyglądają tak samo: rozmówca
                // nie ma zdjęcia albo ukrył je w ustawieniach prywatności.
                await this.touch(id);
                return previous;
            }

            const buffer = await fetchBuffer(url, { maxBytes: MAX_AVATAR_MB * 1024 * 1024 });
            const sha = crypto.createHash('sha256').update(buffer).digest('hex');

            if (previous?.sha === sha) {
                await this.touch(id);
                return previous;
            }

            const file = await this.writeFile(id, buffer);
            const version: AvatarVersion = { file, sha, since: new Date().toISOString() };

            const record = this.history.get(id) ?? { checkedAt: null, versions: [] };
            record.versions.push(version);
            record.checkedAt = new Date().toISOString();
            this.history.set(id, record);
            await this.save();

            return version;
        } catch (err) {
            // Pierwsza nieudana próba dla danego kontaktu idzie do konsoli,
            // kolejne już tylko do pliku - inaczej przy paczce relacji
            // ten sam komunikat leciałby kilkanaście razy pod rząd.
            if (!this.history.has(id)) {
                log.once(`avatar:${id}`, `Nie udało się pobrać zdjęcia profilowego (${id}).`, 'debug');
            }
            log.quiet(err, { stage: 'zdjęcie profilowe', chat: id });
            await this.touch(id);
            return previous;
        }
    }

    /**
     * Adres zdjęcia. Serwer WhatsAppa dla części identyfikatorów @lid
     * odmawia, a dla numeru telefonu tego samego człowieka zdjęcie oddaje -
     * i bywa odwrotnie. Dlatego pytamy po kolei o każdy identyfikator,
     * jaki mamy pod ręką.
     */
    private async profilePicUrl(id: string, contact: WaContact | null): Promise<string | null> {
        const candidates = [
            id,
            contact?.id?._serialized,
            contact?.number ? `${contact.number}@c.us` : null,
        ].filter((value, index, all): value is string =>
            Boolean(value) && value !== 'me' && all.indexOf(value) === index,
        );

        // Najpierw odczyt wprost ze Store. Client.getProfilePicUrl() schodzi do
        // requestProfilePicFromServer(), a ten w bieżącym wydaniu WhatsApp Weba
        // wywraca się na "Cannot read properties of undefined (reading
        // 'isNewsletter')" - i to dla każdego kontaktu po kolei, przez co
        // w archiwum nie zapisywało się ani jedno zdjęcie profilowe.
        for (const candidate of candidates) {
            const url = await readProfilePicUrl(this.client, candidate);
            if (url) return url;
        }

        if (typeof this.client.getProfilePicUrl !== 'function') return null;

        let lastError: unknown = null;
        for (const candidate of candidates) {
            try {
                const url = await this.client.getProfilePicUrl(candidate);
                if (url) return url;
            } catch (err) {
                lastError = err;
            }
        }
        if (lastError) throw lastError;
        return null;
    }

    // -- Dysk -------------------------------------------------------------

    /** Zapisuje bajty jako kolejną wersję i zwraca ścieżkę względem _avatars. */
    private async writeFile(id: string, buffer: Buffer): Promise<string> {
        const folder = id.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const day = new Date().toISOString().slice(0, 10);
        await ensureDir(path.join(this.dir, folder));

        const taken = new Set(await listDir(path.join(this.dir, folder)));
        let name = `${day}.jpg`;
        for (let n = 2; taken.has(name); n++) name = `${day}_${n}.jpg`;

        await fs.writeFile(path.join(this.dir, folder, name), buffer);
        return `${folder}/${name}`;
    }

    /** Odnotowuje samo sprawdzenie, bez nowej wersji. */
    private async touch(id: string): Promise<void> {
        const record = this.history.get(id) ?? { checkedAt: null, versions: [] };
        record.checkedAt = new Date().toISOString();
        this.history.set(id, record);
        await this.save();
    }

    private latest(id: string): AvatarVersion | null {
        const versions = this.history.get(id)?.versions;
        return versions && versions.length > 0 ? (versions[versions.length - 1] ?? null) : null;
    }

    /**
     * Ścieżka do zdjęcia widziana z folderu czatu. Relacje siedzą o poziom
     * głębiej (Statusy/Kto), więc ją liczymy, a nie sklejamy na sztywno.
     */
    private relativePath(version: AvatarVersion, chatDir: string): string | null {
        if (!version.file) return null;
        const absolute = path.join(this.dir, version.file);
        return toPosixPath(path.relative(chatDir || this.config.logsDir, absolute));
    }

    private load(): void {
        const saved = readJsonSync<Record<string, AvatarRecord>>(this.historyFile);
        for (const [id, record] of Object.entries(saved ?? {})) {
            if (Array.isArray(record?.versions)) this.history.set(id, record);
        }
    }

    private async save(): Promise<void> {
        try {
            await writeJsonAtomic(this.historyFile, Object.fromEntries(this.history));
        } catch (err) {
            log.error('Nie udało się zapisać historii zdjęć profilowych', err);
        }
    }
}

function checkedAt(record: AvatarRecord | undefined): number {
    if (!record?.checkedAt) return 0;
    const value = Date.parse(record.checkedAt);
    return Number.isFinite(value) ? value : 0;
}

/**
 * Identyfikator, pod którym trzymamy zdjęcie. Przy kontaktach @lid
 * whatsapp-web.js wstawia w id numer telefonu, a gdy i tego nie ma -
 * zostaje identyfikator prosto z wiadomości.
 */
export function avatarIdOf(contact: WaContact | null, message: WaMessage | null): string | null {
    return (
        contact?.id?._serialized ??
        (contact?.number ? `${contact.number}@c.us` : null) ??
        message?.author ??
        message?.from ??
        null
    );
}
