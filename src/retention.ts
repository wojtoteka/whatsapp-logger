// Kasowanie starych plików z archiwum.
//
// Po RETENTION_DAYS dniach znikają pliki HTML z wiadomościami i pobrane
// media. Wiek liczymy z daty modyfikacji pliku. Zdjęcia profilowe
// (_avatars) i pliki stanu (_state.json) zostają - stan trzyma wiadomości,
// które jeszcze nie wypełniły partii, a te kasuje osobno archiwum.

import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './log';
import { STATUS_DIR } from './statuses';
import { formatBytes, listDirents } from './util';

/** Foldery, do których kasowanie w ogóle nie wchodzi. */
const KEEP_DIRS = new Set(['_avatars']);

/** Pliki, które zostają niezależnie od wieku. */
const KEEP_FILES = new Set(['_state.json']);

/** Relacje leżą o poziom głębiej (Statusy/<autor>/media) niż zwykły czat. */
const NESTED_DIRS = new Set([STATUS_DIR]);

export interface RetentionStats {
    files: number;
    bytes: number;
    errors: string[];
}

/**
 * Przechodzi folder archiwum i kasuje to, co przekroczyło termin.
 * Zwraca statystyki - liczbę plików, zwolnione miejsce i napotkane błędy.
 */
export async function runRetention(logsDir: string, days: number): Promise<RetentionStats> {
    const stats: RetentionStats = { files: 0, bytes: 0, errors: [] };
    if (!days || days <= 0) return stats;

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    for (const entry of await listDirents(logsDir)) {
        if (!entry.isDirectory() || KEEP_DIRS.has(entry.name)) continue;

        await sweepDir(
            path.join(logsDir, entry.name),
            cutoff,
            stats,
            NESTED_DIRS.has(entry.name) ? 2 : 1,
        );
    }

    if (stats.files > 0 || stats.errors.length > 0) {
        await writeRetentionLog(logsDir, stats, days);
        log.info(
            `[Kasowanie] usunięto ${stats.files} plików, zwolniono ${formatBytes(stats.bytes) ?? '0 B'}`,
        );
        for (const error of stats.errors.slice(0, 5)) log.warn(`[Kasowanie] ${error}`);
    }

    return stats;
}

/**
 * Kasuje w jednym folderze pliki starsze niż cutoff. depth mówi, ile
 * poziomów wgłąb wolno jeszcze zejść - zwykły czat ma media/ tuż pod sobą,
 * relacje jeden poziom niżej.
 */
async function sweepDir(
    dir: string,
    cutoff: number,
    stats: RetentionStats,
    depth: number,
): Promise<void> {
    for (const entry of await listDirents(dir)) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (depth <= 0 || KEEP_DIRS.has(entry.name)) continue;
            await sweepDir(full, cutoff, stats, depth - 1);
            continue;
        }
        if (KEEP_FILES.has(entry.name)) continue;

        try {
            const info = await fs.stat(full);
            if (info.mtimeMs >= cutoff) continue;

            await fs.rm(full, { force: true });
            stats.files++;
            stats.bytes += info.size;
        } catch (err) {
            stats.errors.push(`${full}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

async function writeRetentionLog(logsDir: string, stats: RetentionStats, days: number): Promise<void> {
    const line =
        `${new Date().toISOString()} usunięto ${stats.files} plików ` +
        `(${formatBytes(stats.bytes) ?? '0 B'}), starszych niż ${days} dni` +
        (stats.errors.length > 0 ? `, błędów: ${stats.errors.length}` : '');

    try {
        await fs.appendFile(path.join(logsDir, '_kasowanie.log'), `${line}\n`, 'utf8');
    } catch {
        // Dziennik kasowania to wygoda, nie warunek działania.
    }
}
