import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../src/log';
import {
    checkStore,
    clearFullHistoryScan,
    fetchMessagesRaw,
    findChrome,
    healthLine,
    listChatsRaw,
    listContactChatIds,
    listStatusMessages,
    prepareFullHistoryScan,
    readChatSubject,
    readFullHistoryBatch,
    readProfilePicUrl,
    waitForContacts,
} from '../src/waClient';
import { messageKey } from '../src/identity';
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

/**
 * Strona bez window.Store, ale z działającym window.require. Tak wygląda
 * WhatsApp Web, zanim biblioteka zdąży wstrzyknąć własny Store albo gdy
 * przeładowanie strony go zabrało.
 */
function pageWithModules(modules: Record<string, unknown>): WaClient {
    return {
        pupPage: {
            async evaluate<T>(fn: (...args: never[]) => T, ...args: unknown[]): Promise<T> {
                const target = globalThis as unknown as Record<string, unknown>;
                const savedStore = target.Store;
                const savedRequire = target.require;
                delete target.Store;
                target.require = (name: string): unknown => {
                    if (!(name in modules)) throw new Error(`brak modułu ${name}`);
                    return modules[name];
                };
                try {
                    return await (fn as (...a: unknown[]) => T)(...args);
                } finally {
                    if (savedStore === undefined) delete target.Store;
                    else target.Store = savedStore;
                    if (savedRequire === undefined) delete target.require;
                    else target.require = savedRequire;
                }
            },
        },
    } as unknown as WaClient;
}

test('pełna historia jest przekazywana z WhatsApp Store do Node w paczkach', async () => {
    const chatId = '5550100@c.us';
    const model = (id: string, timestamp: number) => ({
        id: { _serialized: id, id, remote: chatId, fromMe: false },
        t: timestamp,
        from: chatId,
        to: 'me@c.us',
        type: 'chat',
        body: id,
    });
    const messages = [model('newer', 20)];
    const older = model('older', 10);
    let loads = 0;
    const chat = { msgs: { getModelsArray: () => messages } };
    const target = globalThis as unknown as Record<string, unknown>;
    const savedWindow = target.window;
    target.window = {
        Store: {
            ConversationMsgs: {
                async loadEarlierMsgs() {
                    loads++;
                    if (loads > 1) return [];
                    messages.unshift(older);
                    return [older];
                },
            },
        },
        WWebJS: {
            async getChat() {
                return chat;
            },
            getMessageModel(value: unknown) {
                return value;
            },
        },
    };
    const client = {
        pupPage: {
            async evaluate<T>(fn: (...args: never[]) => T, ...args: unknown[]): Promise<T> {
                return await (fn as (...values: unknown[]) => T)(...args);
            },
        },
    } as unknown as WaClient;

    try {
        assert.deepEqual(await prepareFullHistoryScan(client, chatId), {
            supported: true,
            total: 2,
        });
        const first = await readFullHistoryBatch(client, chatId, 0, 1);
        const second = await readFullHistoryBatch(client, chatId, 1, 1);
        assert.deepEqual(first.map(messageKey), ['older']);
        assert.deepEqual(second.map(messageKey), ['newer']);
        await clearFullHistoryScan(client, chatId);
    } finally {
        if (savedWindow === undefined) delete target.window;
        else target.window = savedWindow;
    }
});

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

test('bez window.Store dane bierzemy wprost z modułów WhatsApp Weba', async () => {
    // Inaczej start czekał pełne 90 sekund i szedł dalej z pustymi danymi,
    // mimo że kolekcje były gotowe do odczytania.
    const health = await checkStore(
        pageWithModules({
            WAWebCollections: { Contact: collection(120), Chat: collection(30), Msg: collection(0) },
            WAWebWidFactory: { createWid: () => null },
            WAWebApiContact: { getPhoneNumber: () => null },
        }),
    );

    assert.equal(health.store, true);
    assert.equal(health.complete, true);
    assert.equal(health.contacts, 120);
    assert.equal(health.chats, 30);
    assert.deepEqual(health.missing, []);
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

// ── Odczyt prosto ze Store ───────────────────────────────────────────────
//
// Te testy wykonują kod, który normalnie leci do Chromium. Nie sprawdzą, czy
// WhatsApp Web faktycznie ma dziś taką kolekcję - to da się zobaczyć tylko na
// żywej sesji. Sprawdzają natomiast całą logikę, która wcześniej istniała
// wyłącznie w przeglądarce i była poza zasięgiem testów.

/**
 * Udawana strona. evaluate() wykonuje wstrzykiwaną funkcję na miejscu, a wynik
 * przepuszcza przez JSON - dokładnie tak, jak robi to puppeteer. Dzięki temu
 * test wyłapie również wartość, której nie da się przenieść ze strony do Node.
 */
async function withFakeWindow<T>(win: unknown, run: (client: WaClient) => Promise<T>): Promise<T> {
    const target = globalThis as unknown as Record<string, unknown>;
    const saved = target.window;
    target.window = win;

    const client = {
        pupPage: {
            async evaluate<R>(fn: (...args: never[]) => R, ...args: unknown[]): Promise<R> {
                const value = await (fn as (...a: unknown[]) => R)(...args);
                return (value === undefined ? undefined : JSON.parse(JSON.stringify(value))) as R;
            },
        },
    } as unknown as WaClient;

    try {
        return await run(client);
    } finally {
        if (saved === undefined) delete target.window;
        else target.window = saved;
    }
}

/** Model wiadomości w kształcie, jaki oddaje WWebJS.getMessageModel(). */
function rawModel(id: string, timestamp: number, chatId: string): Record<string, unknown> {
    return {
        id: { _serialized: id, id, remote: chatId, fromMe: false },
        t: timestamp,
        from: chatId,
        to: 'me@c.us',
        type: 'chat',
        body: id,
    };
}

test('surowa lista czatów pomija wadliwy model, zamiast paść razem z nim', async () => {
    // Dokładnie ta sytuacja, w której getChats() kończy się błędem "r: r":
    // jednego czatu nie da się opisać, a lista ma mimo to dojść do końca.
    const chats: unknown[] = [
        { id: { _serialized: '5550100@c.us' }, formattedTitle: 'Albert' },
        {
            id: { _serialized: 'grupa@g.us' },
            get formattedTitle(): string {
                throw new Error('r: r');
            },
        },
        { id: null, formattedTitle: 'bez identyfikatora' },
        { id: { _serialized: '5550100@c.us' }, formattedTitle: 'ten sam czat drugi raz' },
    ];

    const result = await withFakeWindow(
        { Store: { Chat: { getModelsArray: () => chats } } },
        (client) => listChatsRaw(client),
    );

    assert.deepEqual(result, [
        { id: '5550100@c.us', name: 'Albert', lastActivity: 0, unread: 0 },
        { id: 'grupa@g.us', name: '', lastActivity: 0, unread: 0 },
    ]);
});

test('brak Store.Chat nie kończy listy czatów - zostaje moduł WhatsApp Weba', async () => {
    const result = await withFakeWindow(
        {
            require: (name: string): unknown => {
                if (name !== 'WAWebCollections') throw new Error(`brak modułu ${name}`);
                return {
                    Chat: {
                        getModelsArray: () => [{ id: { _serialized: '5550100@c.us' }, name: 'Albert' }],
                    },
                };
            },
        },
        (client) => listChatsRaw(client),
    );

    assert.deepEqual(result, [{ id: '5550100@c.us', name: 'Albert', lastActivity: 0, unread: 0 }]);
});

test('pusta kolekcja czatów nie udaje odpowiedzi, na której da się polegać', async () => {
    const result = await withFakeWindow(
        { Store: { Chat: { getModelsArray: () => [] } } },
        (client) => listChatsRaw(client),
    );

    // null, a nie [] - inaczej nadrabianie uznałoby, że nie ma żadnych rozmów,
    // zamiast sięgnąć po publiczne API.
    assert.equal(result, null);
});

test('kontakty do pełnego nadrabiania biorą numer telefonu przed @lid', async () => {
    const contacts: unknown[] = [
        { id: { _serialized: '111@lid' }, phoneNumber: { _serialized: '5550100@c.us' } },
        { id: { _serialized: '5550200@c.us' } },
        { id: { _serialized: '222@lid' } },
        { id: { _serialized: 'status@broadcast' } },
        { id: { _serialized: 'grupa@g.us' } },
        { id: null },
    ];

    const result = await withFakeWindow(
        { Store: { Contact: { getModelsArray: () => contacts } } },
        (client) => listContactChatIds(client),
    );

    assert.deepEqual(result, ['5550100@c.us', '5550200@c.us', '222@lid']);
});

test('surowy odczyt wiadomości pogłębia historię i oddaje ostatnie po czasie', async () => {
    const chatId = '5550100@c.us';
    const powiadomienie = { ...rawModel('powiadomienie', 25, chatId), isNotification: true };
    const msgs: unknown[] = [rawModel('n3', 30, chatId), powiadomienie];
    let loads = 0;

    const result = await withFakeWindow(
        {
            Store: {
                ConversationMsgs: {
                    async loadEarlierMsgs(): Promise<unknown[]> {
                        loads++;
                        if (loads > 1) return [];
                        return [rawModel('n1', 10, chatId), rawModel('n2', 20, chatId)];
                    },
                },
            },
            WWebJS: {
                async getChat() {
                    return { msgs: { getModelsArray: () => msgs } };
                },
                getMessageModel: (message: unknown) => message,
            },
        },
        (client) => fetchMessagesRaw(client, chatId, 2),
    );

    assert.deepEqual(result?.map((message) => messageKey(message)), ['n2', 'n3']);
    assert.equal(loads, 1, 'po osiągnięciu limitu nie schodzimy głębiej');
});

test('brak WWebJS oddaje null, żeby nadrabianie wróciło do publicznego API', async () => {
    const result = await withFakeWindow({ Store: {} }, (client) =>
        fetchMessagesRaw(client, '5550100@c.us', 25),
    );

    assert.equal(result, null);
});

test('relacje czytamy wprost z kolekcji, a jedna wadliwa nie zabiera reszty', async () => {
    const status = (author: string, id: string, timestamp: number): unknown => ({
        msgs: {
            getModelsArray: () => [
                {
                    ...rawModel(id, timestamp, author),
                    id: { _serialized: id, id, remote: 'status@broadcast', participant: author },
                    to: 'status@broadcast',
                    isStatusV3: true,
                },
            ],
        },
    });
    const wadliwa: unknown = {
        get msgs(): unknown {
            throw new Error('r: r');
        },
    };

    const result = await withFakeWindow(
        {
            Store: {
                Status: {
                    getModelsArray: () => [
                        status('999@lid', 'relacja-1', 10),
                        wadliwa,
                        status('888@lid', 'relacja-2', 20),
                    ],
                },
            },
            WWebJS: { getMessageModel: (message: unknown) => message },
        },
        (client) => listStatusMessages(client),
    );

    assert.deepEqual(result?.map((message) => messageKey(message)), ['relacja-1', 'relacja-2']);
});

// ── Nazwa czatu i zdjęcie profilowe wprost ze Store ──────────────────────

/** Kolekcja Store w kształcie, jakiego używa odczyt po identyfikatorze. */
function byId(entries: Record<string, unknown>): { get(key: unknown): unknown } {
    return { get: (key: unknown) => entries[String(key)] ?? undefined };
}

test('nazwa grupy przychodzi z modelu czatu, bez serializacji', async () => {
    const result = await withFakeWindow(
        {
            Store: {
                WidFactory: { createWid: (id: string) => id },
                Chat: byId({ 'grupa@g.us': { formattedTitle: '  Ekipa z pracy  ' } }),
            },
        },
        (client) => readChatSubject(client, 'grupa@g.us'),
    );

    assert.equal(result, 'Ekipa z pracy');
});

test('gdy modelu grupy nie ma, tytuł bierzemy z jej metadanych', async () => {
    // Dokładnie ta sytuacja, w której getChat() kończył się błędem "r: r",
    // a grupa zostawała w archiwum pod samym identyfikatorem.
    const result = await withFakeWindow(
        {
            Store: {
                WidFactory: { createWid: (id: string) => id },
                Chat: {
                    get() {
                        throw new Error('r: r');
                    },
                },
                GroupMetadata: byId({ 'grupa@g.us': { subject: 'Ekipa z pracy' } }),
            },
        },
        (client) => readChatSubject(client, 'grupa@g.us'),
    );

    assert.equal(result, 'Ekipa z pracy');
});

test('wywrotka na getterze nazwy nie kończy odczytu tytułu', async () => {
    const chat = {
        get formattedTitle(): string {
            throw new Error('r: r');
        },
        name: 'Ekipa z pracy',
    };

    const result = await withFakeWindow(
        {
            Store: {
                WidFactory: { createWid: (id: string) => id },
                Chat: byId({ 'grupa@g.us': chat }),
            },
        },
        (client) => readChatSubject(client, 'grupa@g.us'),
    );

    assert.equal(result, 'Ekipa z pracy');
});

test('zdjęcie profilowe bierzemy z miniatury, bez pytania serwera', async () => {
    let pytaniaDoSerwera = 0;

    const result = await withFakeWindow(
        {
            Store: {
                WidFactory: { createWid: (id: string) => id },
                ProfilePicThumb: byId({
                    '5550100@c.us': { eurl: 'https://pps.whatsapp.net/miniatura.jpg' },
                }),
                ProfilePic: {
                    requestProfilePicFromServer(): never {
                        pytaniaDoSerwera++;
                        throw new Error("Cannot read properties of undefined (reading 'isNewsletter')");
                    },
                },
            },
        },
        (client) => readProfilePicUrl(client, '5550100@c.us'),
    );

    assert.equal(result, 'https://pps.whatsapp.net/miniatura.jpg');
    assert.equal(pytaniaDoSerwera, 0);
});

test('awaria requestProfilePicFromServer nie przewraca pobierania zdjęcia', async () => {
    // Ten wyjątek leciał dla każdego kontaktu po kolei i w archiwum nie
    // zapisywało się ani jedno zdjęcie profilowe.
    const result = await withFakeWindow(
        {
            Store: {
                WidFactory: { createWid: (id: string) => id },
                ProfilePicThumb: {
                    get: () => undefined,
                    find: () => undefined,
                },
                ProfilePic: {
                    requestProfilePicFromServer(): never {
                        throw new Error("Cannot read properties of undefined (reading 'isNewsletter')");
                    },
                    profilePicFind: () => ({ eurl: 'https://pps.whatsapp.net/zapasowa.jpg' }),
                },
            },
        },
        (client) => readProfilePicUrl(client, '5550100@c.us'),
    );

    assert.equal(result, 'https://pps.whatsapp.net/zapasowa.jpg');
});
