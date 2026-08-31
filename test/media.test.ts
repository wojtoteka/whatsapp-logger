import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadMediaFromStore, MediaDownloader } from '../src/media';
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

test('znany plik ponad limit nie jest pobierany do pamięci', async () => {
    await withTempDir(async (dir) => {
        let calls = 0;
        const announcedSize = 101 * 1024 * 1024;
        const message = fakeMessage({ id: 'duży-film', type: 'video', hasMedia: true });
        message._data = { size: announcedSize, filename: 'film.mp4' };
        (message as { downloadMedia: () => Promise<unknown> }).downloadMedia = async () => {
            calls++;
            return { data: Buffer.alloc(1).toString('base64'), mimetype: 'video/mp4' };
        };

        const result = await new MediaDownloader(testConfig(dir)).download(message, target(dir));

        assert.equal(calls, 0, 'downloadMedia nie powinno zostać wywołane');
        assert.equal(result.path, null);
        assert.equal(result.skipped?.bytes, announcedSize);
        assert.equal(result.skipped?.filename, 'film.mp4');
        assert.equal(result.skipped?.reason, 'plik ponad limit 100 MB');
    });
});

test('plik równy limitowi 100 MB nadal może zostać pobrany', async () => {
    await withTempDir(async (dir) => {
        let calls = 0;
        const message = fakeMessage({ id: 'film-na-granicy', type: 'video', hasMedia: true });
        message._data = { size: 100 * 1024 * 1024 };
        (message as { downloadMedia: () => Promise<unknown> }).downloadMedia = async () => {
            calls++;
            return { data: Buffer.from('mały-test').toString('base64'), mimetype: 'video/mp4' };
        };

        const result = await new MediaDownloader(testConfig(dir)).download(message, target(dir));

        assert.equal(calls, 1);
        assert.equal(result.skipped, null);
        assert.ok(result.path);
    });
});

// ── Pobieranie wprost ze Store ───────────────────────────────────────────

/**
 * Uruchamia page.evaluate() na tym procesie. Kod z media.ts sięga po
 * globalThis, więc atrapy Store i FileReadera wstawiamy właśnie tam.
 */
async function withFakeStore<T>(globals: Record<string, unknown>, run: (message: WaMessage) => Promise<T>): Promise<T> {
    const target = globalThis as unknown as Record<string, unknown>;
    const saved = new Map(Object.keys(globals).map((key) => [key, target[key]]));
    Object.assign(target, globals);

    const message = fakeMessage({ id: 'z-plikiem', hasMedia: true, type: 'image' });
    (message as WaMessage).client = {
        pupPage: {
            async evaluate<R>(fn: (...args: never[]) => R, ...args: unknown[]): Promise<R> {
                return (await (fn as (...a: unknown[]) => R)(...args)) as R;
            },
        },
    } as unknown as NonNullable<WaMessage['client']>;

    try {
        return await run(message);
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete target[key];
            else target[key] = value;
        }
    }
}

/** FileReader w kształcie, którego używa odczyt gotowego blobu. */
function fakeFileReader(base64: string | null): new () => Record<string, unknown> {
    return class {
        result: string | null = null;
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;

        readAsDataURL(): void {
            this.result = base64 === null ? null : `data:image/jpeg;base64,${base64}`;
            queueMicrotask(() => this.onloadend?.());
        }
    } as unknown as new () => Record<string, unknown>;
}

test('gotowy plik z przeglądarki wystarczy - bez DownloadManagera', async () => {
    // Tak zdjęcie trafiało do archiwum mimo braku directPath i mediaKey,
    // na których kończyło się notatką "nie udało się pobrać pliku".
    const media = await withFakeStore(
        {
            FileReader: fakeFileReader('QUJD'),
            Store: {
                Msg: {
                    get: (id: string) =>
                        id === 'z-plikiem'
                            ? {
                                  id: { _serialized: 'z-plikiem' },
                                  mimetype: 'image/jpeg',
                                  size: 3,
                                  mediaData: { mediaStage: 'RESOLVED', mediaBlob: { _blob: {} } },
                              }
                            : null,
                },
            },
        },
        (message) => downloadMediaFromStore(message, { waitForStageMs: 0 }),
    );

    assert.equal(media?.data, 'QUJD');
    assert.equal(media?.mimetype, 'image/jpeg');
});

test('brak DownloadManagera kończy się pustką, a nie wyjątkiem', async () => {
    const media = await withFakeStore(
        {
            FileReader: fakeFileReader(null),
            Store: {
                Msg: {
                    get: () => ({
                        id: { _serialized: 'z-plikiem' },
                        mediaData: { mediaStage: 'RESOLVED' },
                    }),
                },
            },
        },
        (message) => downloadMediaFromStore(message, { waitForStageMs: 0 }),
    );

    assert.equal(media, null);
});
