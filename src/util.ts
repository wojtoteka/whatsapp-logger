// Drobiazgi używane w całym programie: bezpieczne nazwy plików, obsługa
// dysku i formatowanie liczb. Wszystko na wbudowanych modułach Node -
// nie ma tu ani fs-extra, ani sanitize-filename.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

// ── Nazwy plików i folderów ──────────────────────────────────────────────

/** Znaki, których Windows nie przyjmie w nazwie pliku. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Nazwy zarezerwowane w Windowsie - folder tak nazwany nie powstanie. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Zamienia dowolny tekst w nazwę, którą da się założyć na dysku.
 * Puste wejście albo nazwa złożona z samych zakazanych znaków kończy się
 * wartością zastępczą - nigdy pustym napisem, bo ten rozwaliłby ścieżkę.
 */
export function safeFileName(text: string, fallback = 'bez_nazwy', maxLength = 80): string {
    let name = String(text ?? '')
        .replace(ILLEGAL, '')
        .replace(/\s+/g, '_')
        // Kropki i podkreślenia na brzegach nic nie wnoszą, a kropka
        // na początku dodatkowo ukrywa folder w systemach uniksowych.
        // Nazwa z samych spacji zwija się tu do pustej i spada na zapasową.
        .replace(/^[_.]+|[_.]+$/g, '')
        .trim();

    if (name.length === 0) return sanitizeFallback(fallback);

    // Dopiero teraz, żeby powyższe przycinanie nie zjadło tego podkreślenia.
    if (RESERVED.test(name)) name = `_${name}`;

    // Windows ucina końcowe kropki i spacje, więc lepiej zrobić to samemu.
    name = name.slice(0, maxLength).replace(/[. ]+$/, '');

    return name.length > 0 ? name : sanitizeFallback(fallback);
}

function sanitizeFallback(fallback: string): string {
    const cleaned = String(fallback ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return cleaned.length > 0 ? cleaned : 'bez_nazwy';
}

/** Ścieżka względna zapisana z ukośnikami w przód - taka trafia do HTML. */
export function toPosixPath(value: string): string {
    return value.split(path.sep).join('/');
}

// ── Dysk ─────────────────────────────────────────────────────────────────

export async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
}

export function ensureDirSync(dir: string): void {
    fsSync.mkdirSync(dir, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

export async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

export function readJsonSync<T>(file: string): T | null {
    try {
        return JSON.parse(fsSync.readFileSync(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

/**
 * Zapis JSON-a przez plik tymczasowy i zmianę nazwy. Przerwany zapis
 * zostawiłby obcięty _state.json, a razem z nim wszystkie oczekujące
 * wiadomości czatu - dlatego podmiana jest niepodzielna.
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
    await ensureDir(path.dirname(file));
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(temp, file);
}

/** Tak samo niepodzielnie, ale dla zwykłego tekstu (pliki HTML). */
export async function writeFileAtomic(file: string, contents: string): Promise<void> {
    await ensureDir(path.dirname(file));
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, contents, 'utf8');
    await fs.rename(temp, file);
}

export async function remove(target: string): Promise<void> {
    await fs.rm(target, { recursive: true, force: true });
}

/**
 * Przenosi folder. rename() nie zadziała między dyskami, więc wtedy
 * kopiujemy i kasujemy źródło.
 */
export async function move(from: string, to: string): Promise<void> {
    await ensureDir(path.dirname(to));
    try {
        await fs.rename(from, to);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EXDEV') throw err;
        await fs.cp(from, to, { recursive: true });
        await remove(from);
    }
}

export async function listDir(dir: string): Promise<string[]> {
    try {
        return await fs.readdir(dir);
    } catch {
        return [];
    }
}

export async function listDirents(dir: string): Promise<fsSync.Dirent[]> {
    try {
        return await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

// ── Formatowanie ─────────────────────────────────────────────────────────

export function formatBytes(bytes: number | null | undefined): string | null {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Godziny w formie, która czyta się w komunikacie startowym. */
export function formatHours(hours: number): string {
    if (hours < 1) return `${Math.round(hours * 60)} min`;
    if (Number.isInteger(hours)) return `${hours} h`;
    return `${hours.toFixed(1)} h`;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same cyfry z identyfikatora WhatsAppa, o ile wyglądają na numer telefonu. */
export function phoneDigits(value: unknown): string | null {
    const text =
        typeof value === 'string'
            ? value
            : typeof value === 'object' && value !== null && '_serialized' in value
              ? String((value as { _serialized?: unknown })._serialized ?? '')
              : '';

    const user = text.split('@')[0] ?? '';
    return /^\d{6,}$/.test(user) ? user : null;
}
