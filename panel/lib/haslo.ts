// Sprawdzanie haseł do panelu.
//
// Skróty zakłada logger (npm start -- --uzytkownik) i zapisuje je w formacie:
//
//     scrypt$<N>$<r>$<p>$<sól hex>$<skrót hex>
//
// Tutaj tylko je weryfikujemy - panel nigdy nie zakłada kont sam.
// Format musi się zgadzać z src/haslo.ts po stronie loggera; oba projekty
// są osobnymi paczkami npm, więc tej dwudziestki linii nie da się współdzielić
// bez wciągania jednego w drugi.

import { scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

function scryptAsync(
    password: string,
    salt: Buffer,
    keylen: number,
    options: ScryptOptions,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, keylen, options, (err, derived) => {
            if (err) reject(err);
            else resolve(derived);
        });
    });
}

/**
 * Porównanie idzie przez timingSafeEqual, żeby po czasie odpowiedzi
 * nie dało się zgadywać skrótu bajt po bajcie.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    let salt: Buffer;
    let expected: Buffer;
    try {
        salt = Buffer.from(parts[4] ?? '', 'hex');
        expected = Buffer.from(parts[5] ?? '', 'hex');
    } catch {
        return false;
    }
    if (salt.length === 0 || expected.length === 0) return false;

    try {
        const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
            N,
            r,
            p,
            maxmem: 64 * 1024 * 1024,
        });
        return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
        return false;
    }
}

export function normalizeLogin(login: string): string {
    return login.trim().toLowerCase();
}
