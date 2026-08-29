// Hasła użytkowników panelu.
//
// Bez zewnętrznej biblioteki: scrypt jest wbudowany w Node i jest funkcją
// zaprojektowaną do haseł (kosztowną pamięciowo), więc bcrypt nic by tu
// nie dołożył, a dołożyłby zależność z kodem natywnym.
//
// Format zapisu, celowo prosty i samoopisujący się:
//
//     scrypt$<N>$<r>$<p>$<sól hex>$<skrót hex>
//
// Ten sam format czyta panel przy logowaniu - gdyby kiedyś się rozjechał,
// pilnuje tego test w test/haslo.test.ts.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/**
 * promisify(scrypt) trafia w przeciążenie bez opcji, więc opakowujemy
 * je sami - inaczej nie da się przekazać parametrów kosztu.
 */
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

/** Parametry kosztu. N=16384 to rozsądny kompromis dla logowania do panelu. */
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** Zamienia hasło w napis, który można bezpiecznie trzymać w bazie. */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
        ...PARAMS,
        maxmem: 64 * 1024 * 1024,
    });

    return [
        'scrypt',
        PARAMS.N,
        PARAMS.r,
        PARAMS.p,
        salt.toString('hex'),
        derived.toString('hex'),
    ].join('$');
}

/**
 * Sprawdza hasło. Porównanie idzie przez timingSafeEqual, żeby po czasie
 * odpowiedzi nie dało się zgadywać skrótu bajt po bajcie.
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

/** Login: bez spacji, w jednym, przewidywalnym zapisie. */
export function normalizeLogin(login: string): string {
    return login.trim().toLowerCase();
}

/** Czy hasło nadaje się do użycia. Zwraca powód odmowy albo null. */
export function passwordProblem(password: string): string | null {
    if (password.length < 8) return 'hasło musi mieć co najmniej 8 znaków';
    if (password.trim().length === 0) return 'hasło nie może być samymi spacjami';
    return null;
}
