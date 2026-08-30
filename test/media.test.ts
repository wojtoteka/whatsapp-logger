import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MediaDownloader } from '../src/media';
import type { MediaTarget } from '../src/media';
import type { WaMessage } from '../src/types';
import { fakeMessage, testConfig, withTempDir } from './helpers';

function target(dir: string): MediaTarget {
    return {
        mediaDir: path.join(dir, 'Albert', 'media'),
        chatDir: path.join(dir, 'Albert'),
        isStatus: false,
        label: 'Albert',
    };
}

test('pusty wynik pobierania nie zamyka sprawy - próbujemy jeszcze raz', async () => {
    await withTempDir(async (dir) => {
        let calls = 0;
        const message = fakeMessage({ id: 'zdjęcie', type: 'image', hasMedia: true });
        // Tak zachowuje się WhatsApp Web, gdy pobieranie dopiero ruszyło:
        // biblioteka nie czeka na jego koniec i oddaje pustkę.
        (message as { downloadMedia: () => Promise<unknown> }).downloadMedia = async () => {
            calls++;
            return calls === 1 ? null : { data: Buffer.from('plik').toString('base64'), mimetype: 'image/jpeg' };
        };

        const result = await new MediaDownloader(testConfig(dir)).download(message, target(dir));

        assert.equal(calls, 2, 'drugie podejście doszło do skutku');
        assert.equal(result.skipped, null);
        assert.ok(result.path, 'plik ma ścieżkę w archiwum');
        // Ścieżka jest liczona względem folderu czatu, tak jak w plikach HTML.
        const saved = await fs.readFile(path.join(dir, 'Albert', result.path!), 'utf8');
        assert.equal(saved, 'plik');
    });
});

test('typ wyłączony w konfiguracji zostawia notatkę bez ruszania WhatsAppa', async () => {
    await withTempDir(async (dir) => {
        let calls = 0;
        const message = fakeMessage({ id: 'film', type: 'video', hasMedia: true });
        (message as { downloadMedia: () => Promise<unknown> }).downloadMedia = async () => {
            calls++;
            return null;
        };

        const downloader = new MediaDownloader(testConfig(dir, { mediaTypes: new Set(['image']) }));
        const result = await downloader.download(message as WaMessage, target(dir));

        assert.equal(calls, 0);
        assert.equal(result.path, null);
        assert.equal(result.skipped?.reason, 'typ wyłączony w konfiguracji');
    });
});
