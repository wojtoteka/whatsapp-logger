// Kasowanie starych plików z archiwum
//
// Po RETENTION_DAYS dniach znikają pliki HTML z wiadomościami i pobrane media.
// Wiek liczymy z daty modyfikacji pliku. Zdjęcia profilowe (media/_avatars)
// i pliki stanu (_state.json) zostają.

'use strict';

const fs   = require('fs-extra');
const path = require('path');

const KEEP_DIRS  = new Set(['_avatars']);
const KEEP_FILES = new Set(['_state.json']);

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Usuwa z jednego folderu pliki starsze niż cutoff (znacznik czasu w ms).
 * Nie schodzi do podfolderów z KEEP_DIRS.
 */
async function sweepDir(dir, cutoff, stats, recurse = true) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (!recurse || KEEP_DIRS.has(entry.name)) continue;
            await sweepDir(full, cutoff, stats, false);
            continue;
        }
        if (KEEP_FILES.has(entry.name)) continue;

        try {
            const info = await fs.stat(full);
            if (info.mtimeMs >= cutoff) continue;
            await fs.remove(full);
            stats.files++;
            stats.bytes += info.size;
        } catch (err) {
            stats.errors.push(`${full}: ${err.message}`);
        }
    }
}

/**
 * Przechodzi cały folder logów i kasuje to, co przekroczyło termin.
 * Zwraca { files, bytes, errors }.
 */
async function runRetention(logsDir, days) {
    const stats = { files: 0, bytes: 0, errors: [] };
    if (!days || days <= 0) return stats;

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    let chatDirs;
    try {
        chatDirs = await fs.readdir(logsDir, { withFileTypes: true });
    } catch {
        return stats;
    }

    for (const entry of chatDirs) {
        if (!entry.isDirectory()) continue;
        if (KEEP_DIRS.has(entry.name)) continue;
        await sweepDir(path.join(logsDir, entry.name), cutoff, stats);
    }

    if (stats.files > 0 || stats.errors.length > 0) {
        const line = `${new Date().toISOString()} usunięto ${stats.files} plików ` +
                     `(${formatBytes(stats.bytes)}), starszych niż ${days} dni` +
                     (stats.errors.length ? `, błędów: ${stats.errors.length}` : '');
        try {
            await fs.appendFile(path.join(logsDir, '_retention.log'), line + '\n', 'utf8');
        } catch { /* ignore */ }
        console.log(`[Kasowanie] usunięto ${stats.files} plików, zwolniono ${formatBytes(stats.bytes)}`);
        for (const err of stats.errors.slice(0, 5)) console.warn('[Kasowanie] ', err);
    }

    return stats;
}

module.exports = { runRetention, formatBytes };
