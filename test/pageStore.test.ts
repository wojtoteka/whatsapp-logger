// Dostęp do wnętrza WhatsApp Weba po przeładowaniu strony.
//
// To jest test tej jednej awarii, po której nie schodziły ani pliki, ani
// zdjęcia profilowe, ani relacje: window.Store znika razem z dokumentem,
// a biblioteka odtwarza go dopiero kilkanaście sekund później.

import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadMediaFromStore } from '../src/media';
import { ensurePageAccess, PAGE_HELPER, pageAccessLine } from '../src/pageStore';
import type { WaClient, WaMessage } from '../src/types';
import { fakeMessage } from './helpers';

/**
 * Strona, której evaluate() wykonuje przekazaną funkcję na miejscu, na
 * podstawionym globalThis. Pomocnik zakłada się w tym samym globalThis,
 * więc po każdym teście trzeba go stamtąd sprzątnąć.
 */
async function withPage<T>(
    globals: Record<string, unknown>,
    run: (client: WaClient) => Promise<T>,
): Promise<T> {
    const target = globalThis as unknown as Record<string, unknown>;
    const saved = new Map(Object.keys(globals).map((key) => [key, target[key]]));
    Object.assign(target, globals);

    const client = {
        pupPage: {
            async evaluate<R>(fn: (...args: never[]) => R, ...args: unknown[]): Promise<R> {
                return (await (fn as (...a: unknown[]) => R)(...args)) as R;
            },
        },
    } as unknown as WaClient;

    try {
        return await run(client);
    } finally {
        delete target[PAGE_HELPER];
        for (const [key, value] of saved) {
            if (value === undefined) delete target[key];
            else target[key] = value;
        }
    }
}

/** Rejestr modułów WhatsApp Weba - to on przeżywa przeładowanie strony. */
function fakeRequire(modules: Record<string, unknown>): (name: string) => unknown {
    return (name: string): unknown => {
        if (!(name in modules)) throw new Error(`nie ma modułu ${name}`);
        return modules[name];
    };
}

/** FileReader w kształcie, którego używa odczyt gotowego blobu. */
function fakeFileReader(base64: string): new () => Record<string, unknown> {
    return class {
        result: string | null = null;
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;

        readAsDataURL(): void {
            this.result = `data:image/jpeg;base64,${base64}`;
            queueMicrotask(() => this.onloadend?.());
        }
    } as unknown as new () => Record<string, unknown>;
}

test('kolekcje wracają z window.require, gdy window.Store zniknął po przeładowaniu', async () => {
    const access = await withPage(
        {
            require: fakeRequire({
                WAWebCollections: { Msg: { get: () => null }, Chat: {}, Contact: {} },
            }),
        },
        (client) => ensurePageAccess(client),
    );

    assert.equal(access.ready, true);
    assert.equal(access.source, 'require');
    assert.match(pageAccessLine(access), /odtworzone z window\.require/);
});

test('gotowy window.Store ma pierwszeństwo, a moduły tylko uzupełniają braki', async () => {
    const { access, wzięte } = await withPage(
        {
            FileReader: fakeFileReader('U1RPUkU='),
            Store: {
                Msg: {
                    get: () => ({
                        id: { _serialized: 'z-plikiem' },
                        mimetype: 'image/jpeg',
                        mediaData: { mediaStage: 'RESOLVED', mediaBlob: { _blob: {} } },
                    }),
                },
            },
            require: fakeRequire({
                WAWebCollections: {
                    // Gdyby moduł wygrał ze Store, plik by nie zszedł.
                    Msg: { get: () => null },
                    Chat: {},
                    Contact: {},
                },
            }),
        },
        async (client) => {
            const message = fakeMessage({ id: 'z-plikiem', hasMedia: true, type: 'image' });
            (message as WaMessage).client = client;
            return {
                access: await ensurePageAccess(client),
                wzięte: await downloadMediaFromStore(message, { waitForStageMs: 0 }),
            };
        },
    );

    assert.equal(access.source, 'store');
    assert.equal(wzięte.media?.data, 'U1RPUkU=');
});

test('strona bez Store i bez require jest nazwana wprost, a nie milczy', async () => {
    const access = await withPage({}, (client) => ensurePageAccess(client));

    assert.equal(access.ready, false);
    assert.equal(access.source, 'brak');
    assert.match(pageAccessLine(access), /niedostępne/);
    assert.ok(access.missing.includes('Msg'));
});

test('brak otwartej strony nie jest awarią - po prostu nic nie wiemy', async () => {
    const access = await ensurePageAccess({} as WaClient);

    assert.equal(access.ready, false);
    assert.deepEqual(access.missing, []);
});

test('plik schodzi także wtedy, gdy window.Store zniknął po przeładowaniu', async () => {
    // Dokładnie ta sytuacja zostawiała w archiwum notatkę "przeglądarka nie ma
    // jeszcze Store WhatsAppa", choć WhatsApp Web działał i miał plik u siebie.
    const result = await withPage(
        {
            FileReader: fakeFileReader('QUJD'),
            require: fakeRequire({
                WAWebCollections: {
                    Msg: {
                        get: (id: string) =>
                            id === 'z-plikiem'
                                ? {
                                      id: { _serialized: 'z-plikiem' },
                                      mimetype: 'image/jpeg',
                                      size: 3,
                                      mediaData: {
                                          mediaStage: 'RESOLVED',
                                          mediaBlob: { _blob: {} },
                                      },
                                  }
                                : null,
                    },
                },
            }),
        },
        async (client) => {
            const message = fakeMessage({ id: 'z-plikiem', hasMedia: true, type: 'image' });
            (message as WaMessage).client = client;
            return downloadMediaFromStore(message, { waitForStageMs: 0 });
        },
    );

    assert.equal(result.media?.data, 'QUJD');
    assert.equal(result.why, null);
});

test('gdy nie ma ani Store, ani modułów, notatka mówi o przeładowanej stronie', async () => {
    const result = await withPage({}, async (client) => {
        const message = fakeMessage({ id: 'z-plikiem', hasMedia: true, type: 'image' });
        (message as WaMessage).client = client;
        return downloadMediaFromStore(message, { waitForStageMs: 0 });
    });

    assert.equal(result.media, null);
    assert.match(result.why ?? '', /niedostępne/);
});
