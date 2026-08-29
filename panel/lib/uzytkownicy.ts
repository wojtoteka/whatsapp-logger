// Konta do panelu - odczyt z MariaDB.
//
// Konta zakłada logger (npm start -- --uzytkownik). Panel ich nie tworzy
// ani nie zmienia: sprawdza login i hasło, i tyle.

import mysql from 'mysql2/promise';
import { normalizeLogin, verifyPassword } from './haslo';

export interface PanelUser {
    id: number;
    login: string;
}

let pool: mysql.Pool | null = null;

/** Jedna pula na proces - Next.js trzyma moduły między żądaniami. */
function getPool(): mysql.Pool {
    pool ??= mysql.createPool({
        host: process.env.DB_HOST ?? '127.0.0.1',
        port: Number(process.env.DB_PORT ?? 3306),
        user: process.env.DB_USER ?? 'root',
        password: process.env.DB_PASSWORD ?? '',
        database: process.env.DB_NAME ?? 'whatsapp_logger',
        waitForConnections: true,
        connectionLimit: 3,
        charset: 'utf8mb4_unicode_ci',
    });
    return pool;
}

interface UserRow extends mysql.RowDataPacket {
    id: number;
    login: string;
    password_hash: string;
}

/**
 * Sprawdza login i hasło. Zwraca konto albo null - bez rozróżniania,
 * czy zawiódł login, czy hasło, żeby nie podpowiadać, które konta istnieją.
 */
export async function verifyUser(login: string, password: string): Promise<PanelUser | null> {
    const normalized = normalizeLogin(login);
    if (normalized.length === 0 || password.length === 0) return null;

    try {
        const [rows] = await getPool().query<UserRow[]>(
            'SELECT id, login, password_hash FROM panel_users WHERE login = ? LIMIT 1',
            [normalized],
        );

        const user = rows[0];
        if (!user) return null;
        if (!(await verifyPassword(password, user.password_hash))) return null;

        // Data ostatniego logowania to wygoda przy przeglądaniu bazy -
        // nieudany zapis nie ma prawa zablokować samego logowania.
        void getPool()
            .query('UPDATE panel_users SET last_login_at = NOW() WHERE id = ?', [user.id])
            .catch(() => undefined);

        return { id: user.id, login: user.login };
    } catch {
        // Baza niedostępna - logowanie po prostu się nie uda.
        return null;
    }
}

/** Czy w bazie jest w ogóle jakieś konto. Pokazujemy to na stronie logowania. */
export async function hasAnyUser(): Promise<boolean> {
    try {
        const [rows] = await getPool().query<mysql.RowDataPacket[]>(
            'SELECT 1 FROM panel_users LIMIT 1',
        );
        return rows.length > 0;
    } catch {
        return false;
    }
}
