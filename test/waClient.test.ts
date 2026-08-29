import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../src/log';
import { checkStore, findChrome, healthLine, waitForContacts } from '../src/waClient';
import type { WaClient } from '../src/types';
import { withTempDir } from './helpers';

log.setLevel('error');

/** Udawana strona: evaluate() wykonuje przekazaną funkcję na miejscu. */
function pageWithStore(store: unknown, onCall?: () => void): WaClient {
    return {
        pupPage: {
            async evaluate<T>(fn: (...args: never[]) => T, ...args: unknown[]): Promise<T> {
                onCall?.();
                const target = globalThis as unknown as Record<string, unknown>;
                const saved = target.Store;
                target.Store = store;
                try {
                    return await (fn as (...a: unknown[]) => T)(...args);
                } finally {
                    if (saved === undefined) delete target.Store;
                    else target.Store = saved;
                }
            },
        },
    } as unknown as WaClient;
}

function collection(size: number): { getModelsArray: () => unknown[] } {
    return { getModelsArray: () => new Array<unknown>(size).fill(null) };
}

/** Store w komplecie, tak jak wygląda po pełnym wstrzyknięciu. */
function fullStore(contacts: number, chats: number): Record<string, unknown> {
    return {
        WidFactory: {},
        LidUtils: {},
        Msg: collection(0),
        Contact: collection(contacts),
        Chat: collection(chats),
    };
}

test('brak window.Store rozpoznajemy jako stronę, która nic jeszcze nie udostępnia', async () => {
    const health = await checkStore(pageWithStore(undefined));

    assert.equal(health.store, false);
    assert.equal(health.complete, false);
    // Komunikat nie ma wieszczyć, że nazwy będą cyframi - program dociąga je
    // przy każdej wiadomości i przenosi foldery, gdy pozna lepszą.
    assert.match(healthLine(health), /Nie zajrzałem do danych/);
    assert.doesNotMatch(healthLine(health), /samymi cyframi/);
});

test('niepełne wstrzyknięcie Store jest wykrywane i nazwane po imieniu', async () => {
    // Dokładnie to psuło poprzednią wersję: Store istniał, ale bez WidFactory,
    // więc rozpoznawanie numerów wywracało się na "createWid of undefined".
    const health = await checkStore(
        pageWithStore({ Contact: collection(5), Chat: collection(2), Msg: collection(0) }),
    );

    assert.equal(health.store, true);
    assert.equal(health.complete, false);
    assert.deepEqual(health.missing.sort(), ['LidUtils', 'WidFactory']);
    assert.match(healthLine(health), /tylko częściowo/);
    assert.match(healthLine(health), /WidFactory/);
});

test('komplet danych daje zielone światło i policzone kontakty', async () => {
    const health = await checkStore(pageWithStore(fullStore(120, 30)));

    assert.equal(health.complete, true);
    assert.equal(health.contacts, 120);
    assert.equal(health.chats, 30);
    assert.deepEqual(health.missing, []);
    assert.match(healthLine(health), /✓ Dane wczytane: 120 kontaktów, 30 czatów/);
});

test('pusta książka adresowa to jeszcze nie gotowość', async () => {
    const health = await checkStore(pageWithStore(fullStore(0, 0)));

    assert.equal(health.complete, true);
    assert.equal(health.contacts, 0);
    assert.match(healthLine(health), /Książka adresowa jest jeszcze pusta/);
});

test('czekanie kończy się w chwili, gdy kontakty faktycznie dojdą', async () => {
    let calls = 0;
    // Store dochodzi do siebie dopiero przy trzecim sprawdzeniu.
    const client = {
        pupPage: {
            async evaluate<T>(fn: (...args: never[]) => T, ...args: unknown[]): Promise<T> {
                calls++;
                const target = globalThis as unknown as Record<string, unknown>;
                const saved = target.Store;
                target.Store = calls < 3 ? fullStore(0, 0) : fullStore(42, 7);
                try {
                    return await (fn as (...a: unknown[]) => T)(...args);
                } finally {
                    if (saved === undefined) delete target.Store;
                    else target.Store = saved;
                }
            },
        },
    } as unknown as WaClient;

    const health = await waitForContacts(client, { timeoutMs: 5000, pollMs: 5 });

    assert.equal(health.contacts, 42);
    assert.equal(calls, 3);
});

test('gdy dane nie przyjdą, program nie wisi w nieskończoność', async () => {
    const client = pageWithStore(fullStore(0, 0));

    const started = Date.now();
    const health = await waitForContacts(client, { timeoutMs: 120, pollMs: 20 });

    assert.equal(health.contacts, 0, 'oddajemy stan, jaki jest, zamiast czekać dalej');
    assert.ok(Date.now() - started < 3000);
});

test('błąd w przeglądarce nie wywraca sprawdzania gotowości', async () => {
    const client = {
        pupPage: {
            evaluate: async () => {
                throw new Error('strona zniknęła');
            },
        },
    } as unknown as WaClient;

    const health = await checkStore(client);

    assert.equal(health.store, false);
    assert.equal(health.complete, false);
    // Powód musi zostać - bez niego "brak danych" nie da się zdiagnozować.
    assert.match(health.error ?? '', /strona zniknęła/);
    assert.match(healthLine(health), /strona zniknęła/);
});

test('przeładowanie strony po sparowaniu jest widoczne w powodzie, a nie zgadywane', async () => {
    // Puppeteer rzuca tym, gdy WhatsApp Web przeładuje się w trakcie pytania.
    const client = {
        pupPage: {
            evaluate: async () => {
                throw new Error('Execution context was destroyed, most likely because of a navigation');
            },
        },
    } as unknown as WaClient;

    const health = await waitForContacts(client, { timeoutMs: 60, pollMs: 20 });

    assert.match(health.error ?? '', /Execution context was destroyed/);
});

test('bez dostępu do strony też dostajemy uczciwą odpowiedź', async () => {
    const health = await checkStore({} as unknown as WaClient);

    assert.equal(health.store, false);
});

test('ścieżka do przeglądarki z konfiguracji jest brana, gdy plik istnieje', async () => {
    await withTempDir(async (dir) => {
        const fake = path.join(dir, 'chrome.exe');
        await fs.writeFile(fake, '', 'utf8');

        assert.equal(findChrome(fake), fake);
    });
});

test('wskazanie nieistniejącej przeglądarki nie kończy się jej użyciem', () => {
    const found = findChrome(path.join('nie', 'ma', 'takiego', 'chrome.exe'));

    // Albo znaleziona systemowa, albo nic - byle nie ścieżka, której nie ma.
    assert.notEqual(found, path.join('nie', 'ma', 'takiego', 'chrome.exe'));
});
