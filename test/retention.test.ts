import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../src/log';
import { runRetention } from '../src/retention';
import { withTempDir } from './helpers';

log.setLevel('error');

const DAY = 24 * 60 * 60 * 1000;

/** Zakłada plik i cofa mu datę modyfikacji o podaną liczbę dni. */
async function fileAged(file: string, days: number, contents = 'x'): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, 'utf8');

    const when = new Date(Date.now() - days * DAY);
    await fs.utimes(file, when, when);
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

test('stare pliki znikają, świeże zostają', async () => {
    await withTempDir(async (dir) => {
        await fileAged(path.join(dir, 'Ala', 'messages_0001.html'), 200);
        await fileAged(path.join(dir, 'Ala', 'messages_0002.html'), 10);
        await fileAged(path.join(dir, 'Ala', 'media', 'stare.jpg'), 200);
        await fileAged(path.join(dir, 'Ala', 'media', 'nowe.jpg'), 3);

        const stats = await runRetention(dir, 180);

        assert.equal(stats.files, 2);
        assert.equal(await exists(path.join(dir, 'Ala', 'messages_0001.html')), false);
        assert.equal(await exists(path.join(dir, 'Ala', 'messages_0002.html')), true);
        assert.equal(await exists(path.join(dir, 'Ala', 'media', 'stare.jpg')), false);
        assert.equal(await exists(path.join(dir, 'Ala', 'media', 'nowe.jpg')), true);
    });
});

test('zdjęcia profilowe i pliki stanu przeżywają kasowanie', async () => {
    await withTempDir(async (dir) => {
        await fileAged(path.join(dir, '_avatars', 'ktos', '2020-01-01.jpg'), 900);
        await fileAged(path.join(dir, 'Ala', '_state.json'), 900);
        await fileAged(path.join(dir, 'Ala', 'messages_0001.html'), 900);

        await runRetention(dir, 180);

        assert.equal(await exists(path.join(dir, '_avatars', 'ktos', '2020-01-01.jpg')), true);
        assert.equal(await exists(path.join(dir, 'Ala', '_state.json')), true);
        assert.equal(await exists(path.join(dir, 'Ala', 'messages_0001.html')), false);
    });
});

test('relacje leżą o poziom głębiej i też podlegają kasowaniu', async () => {
    await withTempDir(async (dir) => {
        await fileAged(path.join(dir, 'Statusy', 'Ala', 'messages_0001.html'), 200);
        await fileAged(path.join(dir, 'Statusy', 'Ala', 'media', 'storka.jpg'), 200);
        await fileAged(path.join(dir, 'Statusy', 'Ala', '_state.json'), 200);

        const stats = await runRetention(dir, 180);

        assert.equal(stats.files, 2);
        assert.equal(await exists(path.join(dir, 'Statusy', 'Ala', 'messages_0001.html')), false);
        assert.equal(await exists(path.join(dir, 'Statusy', 'Ala', 'media', 'storka.jpg')), false);
        assert.equal(await exists(path.join(dir, 'Statusy', 'Ala', '_state.json')), true);
    });
});

test('kasowanie wyłączone zerem nie rusza niczego', async () => {
    await withTempDir(async (dir) => {
        await fileAged(path.join(dir, 'Ala', 'messages_0001.html'), 9000);

        const stats = await runRetention(dir, 0);

        assert.equal(stats.files, 0);
        assert.equal(await exists(path.join(dir, 'Ala', 'messages_0001.html')), true);
    });
});

test('po skasowaniu czegokolwiek powstaje wpis w dzienniku z podsumowaniem', async () => {
    await withTempDir(async (dir) => {
        await fileAged(path.join(dir, 'Ala', 'messages_0001.html'), 400, 'x'.repeat(1024));

        await runRetention(dir, 180);

        const logFile = path.join(dir, '_kasowanie.log');
        assert.equal(await exists(logFile), true);
        assert.match(await fs.readFile(logFile, 'utf8'), /usunięto 1 plików/);
    });
});

test('brak folderu archiwum nie jest błędem', async () => {
    await withTempDir(async (dir) => {
        const stats = await runRetention(path.join(dir, 'nie-ma-mnie'), 180);

        assert.deepEqual(stats, { files: 0, bytes: 0, errors: [] });
    });
});
