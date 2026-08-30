// Zapis archiwum do MariaDB.
//
// Pliki HTML zostają tym, czym były - czytelnym archiwum, które otworzy się
// bez niczego. Baza jest od czego innego: panel potrzebuje sortować, stronicować
// i szukać, a tego po plikach na dysku robić się nie da sensownie.
//
// Media zostają na dysku. W bazie trzymamy tylko ścieżkę do nich, liczoną
// względem folderu archiwum - inaczej jeden film wysadziłby tabelę.

import mysql from 'mysql2/promise';
import path from 'node:path';
import type { Config } from './config';
import { log } from './log';
import type { ArchivedMessage } from './types';
import { toPosixPath } from './util';

/** Wiersz tabeli czatów w postaci, w jakiej go zapisujemy. */
export interface ChatRow {
    id: string;
    name: string;
    nameTier: number;
    folder: string;
    isStatus: boolean;
    isGroup: boolean;
}

/** Wiersz tabeli wiadomości - już z rozwiązanymi ścieżkami. */
export interface MessageRow {
    id: string;
    chatId: string;
    ts: number;
    sender: string;
    fromMe: boolean;
    type: string;
    body: string;
    mediaPath: string | null;
    mediaName: string | null;
    mediaSkipped: string | null;
    avatarPath: string | null;
    isDeleted: boolean;
    deletedAt: string | null;
    isForwarded: boolean;
    quoted: string | null;
    location: string | null;
    contacts: string | null;
    poll: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
//  Schemat
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tworzenie tabel jest idempotentne - można to puszczać przy każdym starcie.
 * utf8mb4 jest tu obowiązkowe: bez niego emoji w treści wiadomości wywracają
 * zapis albo lądują jako znaki zapytania.
 */
export const SCHEMA: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS chats (
        id              VARCHAR(190) NOT NULL,
        name            VARCHAR(255) NOT NULL,
        name_tier       TINYINT      NOT NULL DEFAULT 0,
        folder          VARCHAR(255) NOT NULL,
        is_status       TINYINT(1)   NOT NULL DEFAULT 0,
        is_group        TINYINT(1)   NOT NULL DEFAULT 0,
        avatar_path     VARCHAR(500) NULL,
        message_count   INT          NOT NULL DEFAULT 0,
        last_message_at BIGINT       NULL,
        updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_chats_last (last_message_at DESC),
        KEY idx_chats_status (is_status, last_message_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS messages (
        id            VARCHAR(190) NOT NULL,
        chat_id       VARCHAR(190) NOT NULL,
        ts            BIGINT       NOT NULL,
        sender        VARCHAR(255) NOT NULL,
        from_me       TINYINT(1)   NOT NULL DEFAULT 0,
        type          VARCHAR(40)  NOT NULL,
        body          MEDIUMTEXT   NULL,
        media_path    VARCHAR(500) NULL,
        media_name    VARCHAR(255) NULL,
        media_skipped TEXT         NULL,
        avatar_path   VARCHAR(500) NULL,
        is_deleted    TINYINT(1)   NOT NULL DEFAULT 0,
        deleted_at    DATETIME(3)  NULL,
        is_forwarded  TINYINT(1)   NOT NULL DEFAULT 0,
        quoted        TEXT         NULL,
        location      TEXT         NULL,
        contacts      TEXT         NULL,
        poll          TEXT         NULL,
        PRIMARY KEY (id),
        KEY idx_messages_chat (chat_id, ts DESC),
        KEY idx_messages_ts (ts DESC),
        FULLTEXT KEY ft_messages_body (body)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS panel_users (
        id            INT          NOT NULL AUTO_INCREMENT,
        login         VARCHAR(64)  NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP    NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_panel_users_login (login)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

// ─────────────────────────────────────────────────────────────────────────
//  Zamiana wiadomości na wiersz
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ścieżka do pliku widziana od folderu archiwum, a nie od folderu czatu.
 * Na dysku zapisujemy je względem czatu ("media/x.jpg", "../_avatars/y.jpg"),
 * bo tak działają odnośniki w HTML. Panel serwuje pliki z jednego miejsca,
 * więc potrzebuje wspólnego punktu odniesienia.
 */
export function toArchivePath(chatFolder: string, relative: string | null): string | null {
    if (!relative) return null;

    // path.posix.join sam zwija "..", więc "Statusy/Kontakt" + "../_avatars/x"
    // daje "Statusy/_avatars/x" - dlatego liczymy to na pełnej ścieżce.
    const joined = path.posix.normalize(
        path.posix.join(toPosixPath(chatFolder), toPosixPath(relative)),
    );

    // Nic, co wychodzi poza archiwum, nie ma prawa trafić do bazy.
    return joined.startsWith('..') ? null : joined;
}

function json(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}

/** Buduje wiersz gotowy do zapisu z wiadomości i folderu, w którym leży. */
export function toMessageRow(
    message: ArchivedMessage,
    chatId: string,
    chatFolder: string,
): MessageRow {
    return {
        id: message.id,
        chatId,
        ts: message.timestamp,
        sender: message.from.slice(0, 255),
        fromMe: message.fromMe,
        type: message.type,
        body: message.body ?? '',
        mediaPath: toArchivePath(chatFolder, message.mediaPath),
        mediaName: message.mediaName?.slice(0, 255) ?? null,
        mediaSkipped: json(message.mediaSkipped),
        avatarPath: toArchivePath(chatFolder, message.avatar),
        isDeleted: message.isDeleted,
        deletedAt: sqlDate(message.deletedAt),
        isForwarded: message.isForwarded,
        quoted: json(message.quotedMsg),
        location: json(message.location),
        contacts: json(message.contacts),
        poll: json(message.poll),
    };
}

// ─────────────────────────────────────────────────────────────────────────
//  Połączenie
// ─────────────────────────────────────────────────────────────────────────

export class Database {
    private pool: mysql.Pool | null = null;
    private ready = false;
    /** Ostrzegamy o niedostępnej bazie raz, a nie przy każdej wiadomości. */
    private complainedAt = 0;

    constructor(private readonly config: Config) {}

    get enabled(): boolean {
        return this.config.dbEnabled;
    }

    /**
     * Podłącza się i zakłada tabele, jeśli ich nie ma. Zwraca opis tego,
     * co się stało - do wypisania przy starcie.
     */
    async connect(): Promise<{ ok: boolean; message: string }> {
        if (!this.config.dbEnabled) {
            return { ok: false, message: 'Baza danych: wyłączona (DB_ENABLED=false).' };
        }

        try {
            this.pool = mysql.createPool({
                host: this.config.dbHost,
                port: this.config.dbPort,
                user: this.config.dbUser,
                password: this.config.dbPassword,
                database: this.config.dbName,
                waitForConnections: true,
                connectionLimit: 5,
                charset: 'utf8mb4_unicode_ci',
                // Bez tego sterownik oddaje BIGINT jako napis i znaczniki
                // czasu przestają się dać porównywać liczbowo.
                supportBigNumbers: true,
                bigNumberStrings: false,
            });

            for (const statement of SCHEMA) await this.pool.query(statement);

            // CREATE TABLE nie dodaje kolumn do istniejącej instalacji.
            // Migracja jest celowo mała i idempotentna.
            const [deletedAtColumns] = await this.pool.query(
                "SHOW COLUMNS FROM messages LIKE 'deleted_at'",
            );
            if (Array.isArray(deletedAtColumns) && deletedAtColumns.length === 0) {
                await this.pool.query(
                    'ALTER TABLE messages ADD COLUMN deleted_at DATETIME(3) NULL AFTER is_deleted',
                );
            }

            this.ready = true;
            return {
                ok: true,
                message: `✓ Baza danych: ${this.config.dbUser}@${this.config.dbHost}:${this.config.dbPort}/${this.config.dbName}`,
            };
        } catch (err) {
            this.ready = false;
            log.quiet(err, { stage: 'połączenie z bazą' });
            return {
                ok: false,
                message:
                    `✗ Baza danych: nie udało się połączyć (${describe(err)}). ` +
                    'Archiwum na dysku działa dalej, panel nie zobaczy nowych wiadomości.',
            };
        }
    }

    /**
     * Zapisuje albo aktualizuje czat. Wołane przy każdej zmianie nazwy,
     * więc panel widzi przeprowadzki folderów od razu.
     */
    async saveChat(chat: ChatRow): Promise<void> {
        await this.run(
            `INSERT INTO chats (id, name, name_tier, folder, is_status, is_group)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                name_tier = VALUES(name_tier),
                folder = VALUES(folder),
                is_status = VALUES(is_status),
                is_group = VALUES(is_group)`,
            [chat.id, chat.name, chat.nameTier, chat.folder, chat.isStatus, chat.isGroup],
        );
    }

    /**
     * Dopisuje wiadomość. Ten sam identyfikator nadpisuje wpis, więc
     * oznaczenie skasowanej albo powtórka z przeglądu nie robi duplikatu.
     */
    async saveMessage(row: MessageRow): Promise<void> {
        const result = await this.run(
            `INSERT INTO messages
                (id, chat_id, ts, sender, from_me, type, body, media_path, media_name,
                 media_skipped, avatar_path, is_deleted, deleted_at, is_forwarded, quoted, location, contacts, poll)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                body = VALUES(body),
                media_path = VALUES(media_path),
                media_name = VALUES(media_name),
                media_skipped = VALUES(media_skipped),
                avatar_path = VALUES(avatar_path),
                is_deleted = VALUES(is_deleted),
                deleted_at = VALUES(deleted_at),
                quoted = VALUES(quoted)`,
            [
                row.id,
                row.chatId,
                row.ts,
                row.sender,
                row.fromMe,
                row.type,
                row.body,
                row.mediaPath,
                row.mediaName,
                row.mediaSkipped,
                row.avatarPath,
                row.isDeleted,
                row.deletedAt,
                row.isForwarded,
                row.quoted,
                row.location,
                row.contacts,
                row.poll,
            ],
        );

        // COUNT(*) i MAX() po całej rozmowie przy każdej wiadomości dawały
        // koszt rosnący wraz z archiwum. Licznik zmieniamy tylko dla INSERT.
        if ((result as mysql.ResultSetHeader | null)?.affectedRows === 1) {
            await this.run(
                `UPDATE chats
                    SET message_count = message_count + 1,
                        last_message_at = CASE
                            WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
                            ELSE last_message_at
                        END
                  WHERE id = ?`,
                [row.ts, row.ts, row.chatId],
            );
        }
    }

    /** Oznacza wiadomość jako skasowaną, jeśli baza ją zna. */
    async markDeleted(messageId: string, detectedAt: string): Promise<void> {
        await this.run(
            'UPDATE messages SET is_deleted = 1, deleted_at = COALESCE(deleted_at, ?) WHERE id = ?',
            [sqlDate(detectedAt), messageId],
        );
    }

    /** Zapisuje ścieżkę do bieżącego zdjęcia profilowego czatu. */
    async setChatAvatar(chatId: string, avatarPath: string | null): Promise<void> {
        await this.run('UPDATE chats SET avatar_path = ? WHERE id = ?', [avatarPath, chatId]);
    }

    /**
     * Zakłada konto do panelu albo zmienia hasło istniejącemu.
     * Zwraca true, gdy konto powstało; false, gdy zmieniono hasło.
     */
    async upsertUser(login: string, passwordHash: string): Promise<boolean> {
        const existing = await this.run('SELECT id FROM panel_users WHERE login = ?', [login]);
        const rows = Array.isArray(existing) ? (existing as unknown[]) : [];

        if (rows.length > 0) {
            await this.run('UPDATE panel_users SET password_hash = ? WHERE login = ?', [
                passwordHash,
                login,
            ]);
            return false;
        }

        await this.run('INSERT INTO panel_users (login, password_hash) VALUES (?, ?)', [
            login,
            passwordHash,
        ]);
        return true;
    }

    /** Loginy istniejących kont - do wypisania, bez haseł. */
    async listUsers(): Promise<string[]> {
        const result = await this.run('SELECT login FROM panel_users ORDER BY login', []);
        if (!Array.isArray(result)) return [];
        return (result as Array<{ login?: unknown }>)
            .map((row) => String(row.login ?? ''))
            .filter(Boolean);
    }

    /** Kasuje z bazy wiadomości starsze niż podany znacznik czasu. */
    async deleteOlderThan(cutoffTs: number): Promise<number> {
        const result = await this.run('DELETE FROM messages WHERE ts < ?', [cutoffTs]);
        return (result as mysql.ResultSetHeader | null)?.affectedRows ?? 0;
    }

    async close(): Promise<void> {
        const pool = this.pool;
        this.pool = null;
        this.ready = false;
        if (pool) await pool.end().catch(() => undefined);
    }

    /**
     * Każde zapytanie idzie tędy. Błąd bazy nie ma prawa przerwać
     * archiwizacji - pliki na dysku są ważniejsze niż wpis w tabeli.
     */
    private async run(sql: string, params: unknown[]): Promise<unknown> {
        if (!this.pool || !this.ready) return null;
        try {
            const [result] = await this.pool.query(sql, params);
            return result;
        } catch (err) {
            const now = Date.now();
            if (now - this.complainedAt > 60_000) {
                this.complainedAt = now;
                log.warn(`[Baza] zapytanie nie przeszło: ${describe(err)}`);
            }
            log.quiet(err, { stage: 'zapytanie do bazy' });
            return null;
        }
    }
}

function sqlDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString().slice(0, 23).replace('T', ' ');
}

function describe(err: unknown): string {
    if (err instanceof Error) {
        const code = (err as NodeJS.ErrnoException).code;
        return code ? `${code}: ${err.message}` : err.message;
    }
    return String(err);
}
