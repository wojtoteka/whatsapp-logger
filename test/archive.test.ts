import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Archive, archiveMessageId, formatMessageLine } from '../src/archive';
import type { BackfillProgress } from '../src/archive';
import { log } from '../src/log';
import type { ChatStateFile } from '../src/types';
import { fakeClient, fakeMessage, testConfig, withTempDir } from './helpers';

log.setLevel('error');

test('podgląd wiadomości oznacza zabezpieczony czat kłódką', () => {
    const timestamp = Math.floor(new Date(2026, 0, 2, 3, 4, 5).getTime() / 1000);
    const message = {
        timestamp,
        body: 'tajna wiadomość',
        type: 'chat',
        from: 'Ja',
        fromMe: true,
    };

    assert.equal(formatMessageLine('Kontakt', message), '[03:04:05] [Kontakt] → Ja: tajna wiadomość');
    assert.equal(
        formatMessageLine('Kontakt', message, true),
        '[03:04:05] [Kontakt 🔒] → Ja: tajna wiadomość',
    );
});

test('awaryjne ID bez identyfikatora WhatsAppa jest stabilne, a nie losowe', () => {
    const first = fakeMessage({ body: 'bez id', timestamp: 1_700_000_000 });
    delete (first as unknown as { id?: unknown }).id;
    const copy = { ...first } as typeof first;

    const one = archiveMessageId(first, '111@c.us');
    const two = archiveMessageId(copy, '111@c.us');

    assert.equal(one, two);
    assert.match(one, /^local-\d{17}-\d{6}$/);
    assert.notEqual(archiveMessageId({ ...copy, body: 'inna' } as typeof first, '111@c.us'), one);
});

async function readState(dir: string, folder: string): Promise<ChatStateFile> {
    const raw = await fs.readFile(path.join(dir, folder, '_state.json'), 'utf8');
    return JSON.parse(raw) as ChatStateFile;
}

async function listFiles(dir: string): Promise<string[]> {
    try {
        return (await fs.readdir(dir)).sort();
    } catch {
        return [];
    }
}

test('wiadomość ląduje w folderze nazwanym zapisanym kontaktem, nie cyframi @lid', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({
            lidToPhone: { '999@lid': '5550100@c.us' },
            contacts: {
                '5550100@c.us': { id: { _serialized: '5550100@c.us' }, number: '5550100', name: 'Kontakt', isMyContact: true },
            },
        });
        const archive = new Archive(testConfig(dir), client);

        const saved = await archive.save(
            fakeMessage({ from: '999@lid', body: 'pierwsza', contact: { name: 'Kontakt' } }),
        );

        assert.equal(saved, true);
        assert.ok((await listFiles(dir)).includes('Kontakt'));

        const state = await readState(dir, 'Kontakt');
        assert.equal(state.pendingMessages.length, 1);
        assert.equal(state.pendingMessages[0]?.body, 'pierwsza');
        assert.equal(state.chatName, 'Kontakt');
    });
});

test('po wypełnieniu partii powstaje plik HTML, a stan zaczyna się od nowa', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 3 }),
            fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } }),
        );

        for (let i = 1; i <= 3; i++) {
            await archive.save(fakeMessage({ id: `m${i}`, from: '999@lid', body: `wiadomość ${i}` }));
        }

        const folder = path.join(dir, '5550100');
        const files = await listFiles(folder);
        assert.ok(files.includes('messages_0001.html'), `pliki: ${files.join(', ')}`);

        const html = await fs.readFile(path.join(folder, 'messages_0001.html'), 'utf8');
        assert.ok(html.includes('wiadomość 1'));
        assert.ok(html.includes('wiadomość 3'));

        const state = await readState(dir, '5550100');
        assert.equal(state.pendingMessages.length, 0);
        assert.equal(state.batchNum, 2);
        assert.equal(state.totalMessages, 3);
    });
});

test('druga partia odblokowuje odnośnik "dalej" w pierwszej', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 2 }),
            fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } }),
        );

        for (let i = 1; i <= 4; i++) {
            await archive.save(fakeMessage({ id: `m${i}`, from: '999@lid', body: `w${i}` }));
        }

        const folder = path.join(dir, '5550100');
        const first = await fs.readFile(path.join(folder, 'messages_0001.html'), 'utf8');

        assert.ok(!first.includes('Dalszych części jeszcze nie ma'));
        assert.ok(first.includes('href="messages_0002.html"'));
    });
});

test('lepsza nazwa przenosi folder razem z zapisanymi już plikami', async () => {
    await withTempDir(async (dir) => {
        // Najpierw WhatsApp nie wie nic - czat zakłada się pod numerem.
        const contacts: Record<string, { id: { _serialized: string }; number: string; name?: string }> = {
            '5550100@c.us': { id: { _serialized: '5550100@c.us' }, number: '5550100' },
        };
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' }, contacts });
        const archive = new Archive(testConfig(dir, { messagesPerFile: 1 }), client);

        await archive.save(fakeMessage({ id: 'm1', from: '999@lid', body: 'przed' }));
        assert.ok((await listFiles(dir)).includes('5550100'));

        // Teraz kontakt trafia do książki adresowej.
        contacts['5550100@c.us'] = {
            id: { _serialized: '5550100@c.us' },
            number: '5550100',
            name: 'Kontakt',
        };
        contacts['5550100@c.us'].name = 'Kontakt';
        (contacts['5550100@c.us'] as { isMyContact?: boolean }).isMyContact = true;
        archive.refreshAfterSync();

        await archive.save(fakeMessage({ id: 'm2', from: '999@lid', body: 'po' }));

        const folders = await listFiles(dir);
        assert.ok(folders.includes('Kontakt'), `foldery: ${folders.join(', ')}`);
        assert.ok(!folders.includes('5550100'), 'stary folder nie ma prawa zostać obok nowego');

        // Plik zapisany pod starą nazwą przeprowadził się i ma poprawiony nagłówek.
        const html = await fs.readFile(path.join(dir, 'Kontakt', 'messages_0001.html'), 'utf8');
        assert.ok(html.includes('przed'));
        assert.ok(html.includes('<h1>Kontakt</h1>'));
    });
});

test('niedokończona partia przeżywa nagłe zatrzymanie programu', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });

        // Bez flushAll - tak jakby proces po prostu zniknął.
        const first = new Archive(testConfig(dir, { messagesPerFile: 10 }), client);
        await first.save(fakeMessage({ id: 'm1', from: '999@lid', body: 'przed restartem' }));

        const second = new Archive(testConfig(dir, { messagesPerFile: 10 }), client);
        await second.save(fakeMessage({ id: 'm2', from: '999@lid', body: 'po restarcie' }));

        const state = await readState(dir, '5550100');
        assert.deepEqual(
            state.pendingMessages.map((m) => m.body),
            ['przed restartem', 'po restarcie'],
            'nowa instancja podjęła partię tam, gdzie ją zostawiono',
        );
        assert.equal(state.totalMessages, 2);
    });
});

test('numer partii i licznik wiadomości nie resetują się po restarcie', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });

        const first = new Archive(testConfig(dir, { messagesPerFile: 10 }), client);
        await first.save(fakeMessage({ id: 'm1', from: '999@lid', body: 'przed restartem' }));
        // Zamknięcie zrzuca niedokończoną partię do pliku i zaczyna następną.
        await first.flushAll();

        const second = new Archive(testConfig(dir, { messagesPerFile: 10 }), client);
        await second.save(fakeMessage({ id: 'm2', from: '999@lid', body: 'po restarcie' }));

        const state = await readState(dir, '5550100');
        assert.equal(state.batchNum, 2, 'kolejna partia dostaje następny numer');
        assert.equal(state.totalMessages, 2, 'licznik liczy dalej, a nie od zera');
        assert.equal(state.pendingMessages.length, 1);

        // Druga instancja nie ma prawa założyć sobie osobnego folderu.
        const folders = await listFiles(dir);
        assert.deepEqual(folders, ['5550100', '_czaty.json']);
    });
});

test('zwykła wiadomość nie dubluje się ani na żywo, ani po restarcie', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
        const message = fakeMessage({ id: 'stale-id', from: '999@lid', body: 'raz' });
        const first = new Archive(testConfig(dir, { messagesPerFile: 1 }), client);

        assert.equal(await first.save(message), true);
        assert.equal(await first.save(message), false);

        const restarted = new Archive(testConfig(dir, { messagesPerFile: 1 }), client);
        assert.equal(await restarted.save(message), false);

        const state = await readState(dir, '5550100');
        assert.equal(state.totalMessages, 1);
        assert.deepEqual(state.seenIds, ['stale-id']);
    });
});

test('nadrabianie przegląda poprzednie czaty i dopisuje tylko brakujące wiadomości', async () => {
    await withTempDir(async (dir) => {
        const old = fakeMessage({ id: 'stara', from: '999@lid', body: 'już mam', timestamp: 10 });
        const missing = fakeMessage({ id: 'brakująca', from: '999@lid', body: 'do nadrobienia', timestamp: 20 });
        let syncCalls = 0;
        let requestedLimit = 0;
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
        client.getChats = async () =>
            [
                {
                    id: { _serialized: '999@lid' },
                    syncHistory: async () => {
                        syncCalls++;
                        return true;
                    },
                    fetchMessages: async ({ limit }: { limit: number }) => {
                        requestedLimit = limit;
                        return [missing, old];
                    },
                },
            ] as unknown as Awaited<ReturnType<typeof client.getChats>>;

        const archive = new Archive(testConfig(dir, { messagesPerFile: 100 }), client);
        await archive.save(old);

        assert.deepEqual(await archive.backfillRecent(25), {
            chats: 1,
            skippedNewChats: 0,
            listingFailed: false,
            scanned: 2,
            saved: 1,
            skipped: 1,
            failedChats: 0,
            newChats: 0,
            updated: 0,
            complete: true,
        });
        assert.equal(syncCalls, 1);
        assert.equal(requestedLimit, 25);

        assert.deepEqual(await archive.backfillRecent(25), {
            chats: 1,
            skippedNewChats: 0,
            listingFailed: false,
            scanned: 2,
            saved: 0,
            skipped: 2,
            failedChats: 0,
            newChats: 0,
            updated: 0,
            complete: true,
        });

        const state = await readState(dir, '5550100');
        assert.deepEqual(
            state.pendingMessages.map((message) => message.body),
            ['już mam', 'do nadrobienia'],
        );
    });
});

test('nadrabianie nie odpuszcza, gdy WhatsApp nie oddaje listy czatów', async () => {
    await withTempDir(async (dir) => {
        const old = fakeMessage({ id: 'stara', from: '999@lid', body: 'już mam', timestamp: 10 });
        const missing = fakeMessage({
            id: 'brakująca',
            from: '999@lid',
            body: 'z czasu przestoju',
            timestamp: 20,
        });
        const opened: string[] = [];
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
        // Dokładnie ta awaria, która po każdym offline zostawiała dziurę:
        // jeden wadliwy model odrzuca całą listę czatów.
        client.getChats = async () => {
            throw new Error('r: r');
        };
        client.getChatById = (async (chatId: string) => {
            opened.push(chatId);
            return {
                id: { _serialized: chatId },
                fetchMessages: async () => [missing, old],
            };
        }) as unknown as typeof client.getChatById;

        const archive = new Archive(testConfig(dir, { messagesPerFile: 100 }), client);
        await archive.save(old);

        const stats = await archive.backfillRecent(25);
        assert.equal(stats.listingFailed, false, 'spis archiwum wystarczył za listę czatów');
        assert.equal(stats.saved, 1);
        assert.equal(stats.skipped, 1);
        assert.equal(stats.complete, false, 'zakres jest jawnie oznaczony jako niepełny');

        // Numer i @lid prowadzą do tego samego folderu - czat otwieramy raz,
        // zaczynając od numeru.
        assert.deepEqual(opened, ['5550100@c.us']);

        const state = await readState(dir, '5550100');
        assert.deepEqual(
            state.pendingMessages.map((message) => message.body),
            ['już mam', 'z czasu przestoju'],
        );
    });
});

test('zwykłe nadrabianie pomija czat bez folderu, a jawny tryb może go założyć', async () => {
    await withTempDir(async (dir) => {
        const message = fakeMessage({
            id: 'historyczna',
            from: '999@lid',
            body: 'wiadomość sprzed uruchomienia',
            timestamp: 10,
        });
        let fetchCalls = 0;
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
        client.getChats = async () =>
            [
                {
                    id: { _serialized: '999@lid' },
                    fetchMessages: async () => {
                        fetchCalls++;
                        return [message];
                    },
                },
            ] as unknown as Awaited<ReturnType<typeof client.getChats>>;

        const archive = new Archive(testConfig(dir), client);
        const progress: BackfillProgress[] = [];

        assert.deepEqual(await archive.backfillRecent(25), {
            chats: 0,
            skippedNewChats: 1,
            listingFailed: false,
            scanned: 0,
            saved: 0,
            skipped: 0,
            failedChats: 0,
            newChats: 0,
            updated: 0,
            complete: true,
        });
        assert.equal(fetchCalls, 0);
        assert.deepEqual(await listFiles(dir), []);

        assert.deepEqual(
            await archive.backfillRecent(25, {
                includeNewChats: true,
                onProgress: (event) => progress.push(event),
            }),
            {
                chats: 1,
                skippedNewChats: 0,
                listingFailed: false,
                scanned: 1,
                saved: 1,
                skipped: 0,
                failedChats: 0,
                newChats: 1,
                updated: 0,
                complete: true,
            },
        );
        assert.equal(fetchCalls, 1);
        assert.deepEqual(await listFiles(dir), ['5550100', '_czaty.json']);
        assert.equal(progress[0]?.percent, 0);
        assert.equal(progress.at(-1)?.percent, 100);
        assert.ok(progress.some((event) => event.stage === 'fetching'));
        assert.ok(progress.some((event) => event.stage === 'saving'));
    });
});

test('nadrabianie rozwija czaty pojedynczo, gdy zbiorcze getChats jest uszkodzone', async () => {
    await withTempDir(async (dir) => {
        const message = fakeMessage({
            id: 'do-odzyskania',
            from: '999@lid',
            body: 'odzyskana mimo wadliwego czatu',
        });
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
        let getChatsCalls = 0;
        let getChatByIdCalls = 0;

        // Pierwsze zapytanie do strony oddaje samą listę czatów. Kolejne -
        // kontakty i surowy odczyt wiadomości - udają wydanie WhatsApp Weba,
        // z którego nie da się czytać wprost, więc zostaje publiczne API.
        let evaluateCalls = 0;
        client.pupPage = {
            evaluate: async () => {
                evaluateCalls++;
                if (evaluateCalls > 1) return null;
                return [
                    { id: '999@lid', name: '' },
                    { id: 'wadliwy@g.us', name: 'Wadliwa grupa' },
                ];
            },
        } as unknown as NonNullable<typeof client.pupPage>;
        client.getChats = async () => {
            getChatsCalls++;
            throw new Error('r: r');
        };
        client.getChatById = async (id: string) => {
            getChatByIdCalls++;
            if (id === 'wadliwy@g.us') throw new Error('r: r');
            return {
                id: { _serialized: id },
                fetchMessages: async () => [message],
            } as unknown as Awaited<ReturnType<typeof client.getChatById>>;
        };

        const archive = new Archive(testConfig(dir), client);
        assert.deepEqual(
            await archive.backfillRecent(25, { includeNewChats: true }),
            {
                chats: 2,
                skippedNewChats: 0,
                listingFailed: false,
                scanned: 1,
                saved: 1,
                skipped: 0,
                failedChats: 1,
                newChats: 1,
                updated: 0,
                complete: false,
            },
        );
        assert.equal(getChatsCalls, 0);
        assert.equal(getChatByIdCalls, 2);
    });
});

test('pełne nadrabianie żąda całej dostępnej historii i deduplikuje istniejący rekord', async () => {
    await withTempDir(async (dir) => {
        const old = fakeMessage({ id: 'old', from: '999@lid', body: 'już zapisane', timestamp: 10 });
        const older = fakeMessage({ id: 'older', from: '999@lid', body: 'starsza historia', timestamp: 5 });
        let requestedLimit = 0;
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
        client.getChats = async () =>
            [
                {
                    id: { _serialized: '999@lid' },
                    fetchMessages: async ({ limit }: { limit: number }) => {
                        requestedLimit = limit;
                        return [old, older];
                    },
                },
            ] as unknown as Awaited<ReturnType<typeof client.getChats>>;

        const archive = new Archive(testConfig(dir), client);
        await archive.save(old);
        const stats = await archive.backfillRecent(250, {
            includeNewChats: true,
            fullHistory: true,
        });

        assert.equal(requestedLimit, Number.POSITIVE_INFINITY);
        assert.equal(stats.saved, 1);
        assert.equal(stats.skipped, 1);
        const state = await readState(dir, '5550100');
        assert.equal(state.totalMessages, 2);
        assert.equal(state.sync?.messageId, 'old');
    });
});

test('zmiana zapisanej nazwy aktualizuje ten sam czat bez duplikowania wiadomości', async () => {
    await withTempDir(async (dir) => {
        const contact = {
            id: { _serialized: '5550100@c.us' },
            number: '5550100',
            name: 'Albert Z',
            isMyContact: true,
        };
        const options = {
            lidToPhone: { '999@lid': '5550100@c.us' },
            contacts: { '5550100@c.us': contact, '999@lid': contact },
        };
        const message = fakeMessage({ id: 'same-id', from: '999@lid', contact });

        const first = new Archive(testConfig(dir), fakeClient(options));
        assert.equal(await first.save(message), true);

        contact.name = 'Albert';
        const restarted = new Archive(testConfig(dir), fakeClient(options));
        assert.equal(await restarted.save(message), false);

        const state = await readState(dir, 'Albert');
        assert.equal(state.chatName, 'Albert');
        assert.equal(state.totalMessages, 1);
        await assert.rejects(fs.access(path.join(dir, 'Albert Z')));
    });
});

test('zamknięcie programu zrzuca na dysk to, co czeka w pamięci', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 100 }),
            fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } }),
        );

        await archive.save(fakeMessage({ id: 'm1', from: '999@lid', body: 'niedokończona partia' }));
        await archive.flushAll();

        const html = await fs.readFile(
            path.join(dir, '5550100', 'messages_0001.html'),
            'utf8',
        );
        assert.ok(html.includes('niedokończona partia'));
    });
});

test('relacje trafiają do Statusy/<autor>, osobno od rozmowy z tą osobą', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({
            lidToPhone: { '999@lid': '5550100@c.us' },
            contacts: {
                '5550100@c.us': { id: { _serialized: '5550100@c.us' }, number: '5550100', name: 'Kontakt', isMyContact: true },
            },
        });
        const archive = new Archive(testConfig(dir), client);

        await archive.save(fakeMessage({ id: 'rozmowa', from: '999@lid', body: 'zwykła' }));
        await archive.save(
            fakeMessage({ id: 'relacja', from: 'status@broadcast', author: '999@lid', isStatus: true, body: 'moja relacja' }),
        );

        assert.ok((await listFiles(dir)).includes('Kontakt'));
        assert.ok((await listFiles(path.join(dir, 'Statusy'))).includes('Kontakt'));

        const chat = await readState(dir, 'Kontakt');
        const status = await readState(dir, path.join('Statusy', 'Kontakt'));
        assert.equal(chat.pendingMessages.length, 1);
        assert.equal(status.pendingMessages.length, 1);
        assert.equal(status.pendingMessages[0]?.body, 'moja relacja');
    });
});

test('przegląd nie dopisuje relacji, którą już mamy - także po restarcie', async () => {
    await withTempDir(async (dir) => {
        const relacja = fakeMessage({
            id: 'relacja-1',
            from: 'status@broadcast',
            author: '999@lid',
            isStatus: true,
            body: 'storka',
        });
        const client = fakeClient({
            lidToPhone: { '999@lid': '5550100@c.us' },
            broadcasts: [{ msgs: [relacja] }],
        });

        const archive = new Archive(testConfig(dir), client);
        assert.deepEqual(await archive.sweepStatuses(), { saved: 1, skipped: 0 });
        assert.deepEqual(await archive.sweepStatuses(), { saved: 0, skipped: 1 });

        // Identyfikator jest w _state.json, więc działa też po pełnym restarcie.
        const restarted = new Archive(testConfig(dir), client);
        assert.deepEqual(await restarted.sweepStatuses(), { saved: 0, skipped: 1 });
    });
});

test('relacje bez id._serialized nie dublują się przy kolejnych przeglądach', async () => {
    await withTempDir(async (dir) => {
        // Dokładnie ten kształt przysyła getBroadcasts(). Wcześniej brak
        // _serialized kasował listę znanych identyfikatorów, więc każdy
        // przegląd co 6 h zapisywał te same relacje jeszcze raz.
        const relacje = [
            fakeMessage({ id: 'HASH-A', from: '999@lid', rawStatusId: true, isStatus: true, body: 'a' }),
            fakeMessage({ id: 'HASH-B', from: '999@lid', rawStatusId: true, isStatus: true, body: 'b' }),
        ];
        const client = fakeClient({
            lidToPhone: { '999@lid': '5550100@c.us' },
            broadcasts: [{ msgs: relacje }],
        });

        const archive = new Archive(testConfig(dir, { messagesPerFile: 100 }), client);

        assert.deepEqual(await archive.sweepStatuses(), { saved: 2, skipped: 0 });
        assert.deepEqual(await archive.sweepStatuses(), { saved: 0, skipped: 2 });

        const restarted = new Archive(testConfig(dir, { messagesPerFile: 100 }), client);
        assert.deepEqual(await restarted.sweepStatuses(), { saved: 0, skipped: 2 });

        const state = await readState(dir, path.join('Statusy', '5550100'));
        assert.equal(state.pendingMessages.length, 2, 'dwie relacje, nie sześć');
        assert.equal(state.seenIds?.length, 2, 'identyfikatory muszą trafić na dysk');
    });
});

test('wiadomość skasowana, gdy jeszcze czeka w partii, dostaje znacznik w stanie', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 100 }),
            fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } }),
        );

        const message = fakeMessage({ id: 'do-usuniecia', from: '999@lid', body: 'ups' });
        await archive.save(message);
        await archive.markDeleted(message);

        const state = await readState(dir, '5550100');
        assert.equal(state.pendingMessages[0]?.isDeleted, true);
    });
});

test('wiadomość skasowana po zapisaniu pliku dostaje notkę wprost w HTML', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 1 }),
            fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } }),
        );

        const message = fakeMessage({ id: 'poszla-do-pliku', from: '999@lid', body: 'żałuję' });
        await archive.save(message);

        const file = path.join(dir, '5550100', 'messages_0001.html');
        assert.ok(!(await fs.readFile(file, 'utf8')).includes('Skasowana w WhatsAppie'));

        await archive.markDeleted(message);

        const html = await fs.readFile(file, 'utf8');
        assert.ok(html.includes('Skasowana w WhatsAppie'));
        assert.ok(html.includes('żałuję'), 'treść zostaje w archiwum');

        const batch = JSON.parse(
            await fs.readFile(path.join(dir, '5550100', 'messages_0001.json'), 'utf8'),
        ) as { messages: Array<{ isDeleted: boolean; deletedAt?: string | null }> };
        assert.equal(batch.messages[0]?.isDeleted, true);
        assert.ok(batch.messages[0]?.deletedAt);
    });
});

test('kasowanie po czasie usuwa stare oczekujące wiadomości, także z cichego czatu', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir), fakeClient());

        // Czat, którego ta instancja nie ma w pamięci - tylko na dysku.
        const chatDir = path.join(dir, 'Cichy_czat');
        const now = Math.floor(Date.now() / 1000);
        await fs.mkdir(chatDir, { recursive: true });
        await fs.writeFile(
            path.join(chatDir, '_state.json'),
            JSON.stringify({
                pendingMessages: [
                    { id: 'stara', timestamp: now - 181 * 24 * 60 * 60 },
                    { id: 'nowa', timestamp: now - 2 * 24 * 60 * 60 },
                ],
            }),
            'utf8',
        );

        assert.equal(await archive.pruneOldPending(180), 1);

        const state = await readState(dir, 'Cichy_czat');
        assert.deepEqual(state.pendingMessages.map((m) => m.id), ['nowa']);
    });
});

test('wiadomości systemowe nie zaśmiecają archiwum', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir), fakeClient());

        assert.equal(await archive.save(fakeMessage({ type: 'e2e_notification' })), false);
        assert.equal(await archive.save(fakeMessage({ type: 'gp2' })), false);

        assert.deepEqual(await listFiles(dir), []);
    });
});

test('nazwa czatu z ukośnikiem nie zakłada folderu poza archiwum', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({
            lidToPhone: { '999@lid': '5550100@c.us' },
            contacts: {
                '5550100@c.us': {
                    id: { _serialized: '5550100@c.us' },
                    number: '5550100',
                    name: '../../ucieczka',
                    isMyContact: true,
                },
            },
        });
        const archive = new Archive(testConfig(dir), client);

        await archive.save(fakeMessage({ from: '999@lid', body: 'test' }));

        const folders = await listFiles(dir);
        assert.equal(folders.length, 2, 'jeden folder czatu i spis czatów');
        assert.ok(folders.some((f) => f === 'ucieczka'), `foldery: ${folders.join(', ')}`);
    });
});

test('folder po starszej wersji zostaje przejęty razem z czekającymi w nim wiadomościami', async () => {
    await withTempDir(async (dir) => {
        // Tak nazywała foldery poprzednia wersja: samymi cyframi z @lid,
        // bez żadnego wpisu w spisie czatów.
        const legacyDir = path.join(dir, '999');
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.writeFile(
            path.join(legacyDir, '_state.json'),
            JSON.stringify({
                chatName: '999',
                batchNum: 1,
                totalMessages: 1,
                pendingMessages: [
                    { id: 'stara', timestamp: Math.floor(Date.now() / 1000), body: 'sprzed przepisania', from: 'x', fromMe: false },
                ],
            }),
            'utf8',
        );

        const client = fakeClient({
            lidToPhone: { '999@lid': '5550100@c.us' },
            contacts: {
                '5550100@c.us': { id: { _serialized: '5550100@c.us' }, number: '5550100', name: 'Kontakt', isMyContact: true },
            },
        });
        const archive = new Archive(testConfig(dir, { messagesPerFile: 100 }), client);

        await archive.save(fakeMessage({ id: 'nowa', from: '999@lid', body: 'po przepisaniu' }));

        const folders = await listFiles(dir);
        assert.ok(folders.includes('Kontakt'), `foldery: ${folders.join(', ')}`);
        assert.ok(!folders.includes('999'), 'stary folder nie zostaje sierotą obok nowego');

        const state = await readState(dir, 'Kontakt');
        assert.deepEqual(
            state.pendingMessages.map((m) => m.body),
            ['sprzed przepisania', 'po przepisaniu'],
        );
    });
});

test('spis czatów zapamiętuje, gdzie leży archiwum danej osoby', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir),
            fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } }),
        );
        await archive.save(fakeMessage({ from: '999@lid', body: 'x' }));

        const index = JSON.parse(await fs.readFile(path.join(dir, '_czaty.json'), 'utf8')) as Record<
            string,
            { safeName: string }
        >;

        assert.equal(index['5550100@c.us']?.safeName, '5550100');
        assert.equal(index['999@lid']?.safeName, '5550100', 'wpis jest też pod @lid');
    });
});

test('relacja skasowana z archiwum wraca przy kolejnym przeglądzie', async () => {
    await withTempDir(async (dir) => {
        const relacja = fakeMessage({
            id: 'relacja-1',
            from: 'status@broadcast',
            author: '999@lid',
            isStatus: true,
            body: 'storka',
        });
        const client = fakeClient({
            lidToPhone: { '999@lid': '5550100@c.us' },
            broadcasts: [{ msgs: [relacja] }],
        });

        const archive = new Archive(testConfig(dir), client);
        assert.deepEqual(await archive.sweepStatuses(), { saved: 1, skipped: 0 });

        // Skasowanie relacji z archiwum ma znaczyć "pobierz ją jeszcze raz".
        // Wcześniej pamięć identyfikatorów mówiła "już mam" nawet wtedy, gdy
        // folderu dawno nie było, i relacja nie wracała już nigdy.
        await fs.rm(path.join(dir, 'Statusy'), { recursive: true, force: true });
        assert.deepEqual(await archive.sweepStatuses(), { saved: 1, skipped: 0 });

        const state = await readState(dir, path.join('Statusy', '5550100'));
        assert.equal(state.pendingMessages.length, 1);
    });
});

test('nadrabianie zapisuje wiadomość starszą niż ostatnia zapisana', async () => {
    await withTempDir(async (dir) => {
        const nowsza = fakeMessage({ id: 'nowsza', from: '999@lid', body: 'ostatnia', timestamp: 20 });
        // WhatsApp potrafi dosłać wiadomość z czasu przestoju z jej własną,
        // starszą datą. Odcinanie po znaczniku czasu gubiło ją na zawsze.
        const spoznona = fakeMessage({ id: 'spozniona', from: '999@lid', body: 'z przestoju', timestamp: 15 });

        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
        client.getChats = async () =>
            [
                {
                    id: { _serialized: '999@lid' },
                    fetchMessages: async () => [spoznona, nowsza],
                },
            ] as unknown as Awaited<ReturnType<typeof client.getChats>>;

        const archive = new Archive(testConfig(dir, { messagesPerFile: 100 }), client);
        await archive.save(nowsza);
        await archive.backfillRecent(25);

        const stats = await archive.backfillRecent(25);
        assert.equal(stats.saved, 0, 'drugi przebieg nie dubluje niczego');

        const state = await readState(dir, '5550100');
        assert.deepEqual(
            state.pendingMessages.map((message) => message.body),
            ['ostatnia', 'z przestoju'],
        );
    });
});

test('nadrabianie bierze listę czatów ze strony, bez zbiorczego getChats', async () => {
    await withTempDir(async (dir) => {
        const message = fakeMessage({ id: 'historyczna', from: '999@lid', body: 'sprzed instalacji' });
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });

        let getChatsCalls = 0;
        client.getChats = async () => {
            getChatsCalls++;
            throw new Error('r: r');
        };

        // Świeża instalacja: Store nie ma jeszcze czatu, jest za to kontakt.
        const evaluated: unknown[] = [];
        client.pupPage = {
            evaluate: async () => {
                evaluated.push(null);
                if (evaluated.length === 1) return [];
                if (evaluated.length === 2) return ['5550100@c.us'];
                return null;
            },
        } as unknown as NonNullable<typeof client.pupPage>;
        client.getChatById = async (id: string) =>
            ({
                id: { _serialized: id },
                fetchMessages: async () => [message],
            }) as unknown as Awaited<ReturnType<typeof client.getChatById>>;

        const archive = new Archive(testConfig(dir), client);
        assert.equal(archive.isEmpty, true, 'puste archiwum poznajemy przed startem');

        const stats = await archive.backfillRecent(25, { includeNewChats: true });
        assert.equal(stats.saved, 1);
        assert.equal(getChatsCalls, 0, 'kontakty wystarczyły, zbiorcze getChats nie było potrzebne');
        assert.deepEqual(await listFiles(dir), ['5550100', '_czaty.json']);
        assert.equal(archive.isEmpty, false);
    });
});
