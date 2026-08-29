import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Archive } from '../src/archive';
import { log } from '../src/log';
import type { ChatStateFile } from '../src/types';
import { fakeClient, fakeMessage, testConfig, withTempDir } from './helpers';

log.setLevel('error');

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
            lidToPhone: { '999@lid': '48111222333@c.us' },
            contacts: {
                '48111222333@c.us': { id: { _serialized: '48111222333@c.us' }, number: '48111222333', name: 'Ala', isMyContact: true },
            },
        });
        const archive = new Archive(testConfig(dir), client);

        const saved = await archive.save(
            fakeMessage({ from: '999@lid', body: 'pierwsza', contact: { name: 'Ala' } }),
        );

        assert.equal(saved, true);
        assert.ok((await listFiles(dir)).includes('Ala'));

        const state = await readState(dir, 'Ala');
        assert.equal(state.pendingMessages.length, 1);
        assert.equal(state.pendingMessages[0]?.body, 'pierwsza');
        assert.equal(state.chatName, 'Ala');
    });
});

test('po wypełnieniu partii powstaje plik HTML, a stan zaczyna się od nowa', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 3 }),
            fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' } }),
        );

        for (let i = 1; i <= 3; i++) {
            await archive.save(fakeMessage({ id: `m${i}`, from: '999@lid', body: `wiadomość ${i}` }));
        }

        const folder = path.join(dir, '48111222333');
        const files = await listFiles(folder);
        assert.ok(files.includes('messages_0001.html'), `pliki: ${files.join(', ')}`);

        const html = await fs.readFile(path.join(folder, 'messages_0001.html'), 'utf8');
        assert.ok(html.includes('wiadomość 1'));
        assert.ok(html.includes('wiadomość 3'));

        const state = await readState(dir, '48111222333');
        assert.equal(state.pendingMessages.length, 0);
        assert.equal(state.batchNum, 2);
        assert.equal(state.totalMessages, 3);
    });
});

test('druga partia odblokowuje odnośnik "dalej" w pierwszej', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 2 }),
            fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' } }),
        );

        for (let i = 1; i <= 4; i++) {
            await archive.save(fakeMessage({ id: `m${i}`, from: '999@lid', body: `w${i}` }));
        }

        const folder = path.join(dir, '48111222333');
        const first = await fs.readFile(path.join(folder, 'messages_0001.html'), 'utf8');

        assert.ok(!first.includes('Dalszych części jeszcze nie ma'));
        assert.ok(first.includes('href="messages_0002.html"'));
    });
});

test('lepsza nazwa przenosi folder razem z zapisanymi już plikami', async () => {
    await withTempDir(async (dir) => {
        // Najpierw WhatsApp nie wie nic - czat zakłada się pod numerem.
        const contacts: Record<string, { id: { _serialized: string }; number: string; name?: string }> = {
            '48111222333@c.us': { id: { _serialized: '48111222333@c.us' }, number: '48111222333' },
        };
        const client = fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' }, contacts });
        const archive = new Archive(testConfig(dir, { messagesPerFile: 1 }), client);

        await archive.save(fakeMessage({ id: 'm1', from: '999@lid', body: 'przed' }));
        assert.ok((await listFiles(dir)).includes('48111222333'));

        // Teraz kontakt trafia do książki adresowej.
        contacts['48111222333@c.us'] = {
            id: { _serialized: '48111222333@c.us' },
            number: '48111222333',
            name: 'Ala',
        };
        contacts['48111222333@c.us'].name = 'Ala';
        (contacts['48111222333@c.us'] as { isMyContact?: boolean }).isMyContact = true;
        archive.refreshAfterSync();

        await archive.save(fakeMessage({ id: 'm2', from: '999@lid', body: 'po' }));

        const folders = await listFiles(dir);
        assert.ok(folders.includes('Ala'), `foldery: ${folders.join(', ')}`);
        assert.ok(!folders.includes('48111222333'), 'stary folder nie ma prawa zostać obok nowego');

        // Plik zapisany pod starą nazwą przeprowadził się i ma poprawiony nagłówek.
        const html = await fs.readFile(path.join(dir, 'Ala', 'messages_0001.html'), 'utf8');
        assert.ok(html.includes('przed'));
        assert.ok(html.includes('<h1>Ala</h1>'));
    });
});

test('niedokończona partia przeżywa nagłe zatrzymanie programu', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' } });

        // Bez flushAll - tak jakby proces po prostu zniknął.
        const first = new Archive(testConfig(dir, { messagesPerFile: 10 }), client);
        await first.save(fakeMessage({ id: 'm1', from: '999@lid', body: 'przed restartem' }));

        const second = new Archive(testConfig(dir, { messagesPerFile: 10 }), client);
        await second.save(fakeMessage({ id: 'm2', from: '999@lid', body: 'po restarcie' }));

        const state = await readState(dir, '48111222333');
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
        const client = fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' } });

        const first = new Archive(testConfig(dir, { messagesPerFile: 10 }), client);
        await first.save(fakeMessage({ id: 'm1', from: '999@lid', body: 'przed restartem' }));
        // Zamknięcie zrzuca niedokończoną partię do pliku i zaczyna następną.
        await first.flushAll();

        const second = new Archive(testConfig(dir, { messagesPerFile: 10 }), client);
        await second.save(fakeMessage({ id: 'm2', from: '999@lid', body: 'po restarcie' }));

        const state = await readState(dir, '48111222333');
        assert.equal(state.batchNum, 2, 'kolejna partia dostaje następny numer');
        assert.equal(state.totalMessages, 2, 'licznik liczy dalej, a nie od zera');
        assert.equal(state.pendingMessages.length, 1);

        // Druga instancja nie ma prawa założyć sobie osobnego folderu.
        const folders = await listFiles(dir);
        assert.deepEqual(folders, ['48111222333', '_czaty.json']);
    });
});

test('zamknięcie programu zrzuca na dysk to, co czeka w pamięci', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 100 }),
            fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' } }),
        );

        await archive.save(fakeMessage({ id: 'm1', from: '999@lid', body: 'niedokończona partia' }));
        await archive.flushAll();

        const html = await fs.readFile(
            path.join(dir, '48111222333', 'messages_0001.html'),
            'utf8',
        );
        assert.ok(html.includes('niedokończona partia'));
    });
});

test('relacje trafiają do Statusy/<autor>, osobno od rozmowy z tą osobą', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({
            lidToPhone: { '999@lid': '48111222333@c.us' },
            contacts: {
                '48111222333@c.us': { id: { _serialized: '48111222333@c.us' }, number: '48111222333', name: 'Ala', isMyContact: true },
            },
        });
        const archive = new Archive(testConfig(dir), client);

        await archive.save(fakeMessage({ id: 'rozmowa', from: '999@lid', body: 'zwykła' }));
        await archive.save(
            fakeMessage({ id: 'relacja', from: 'status@broadcast', author: '999@lid', isStatus: true, body: 'moja relacja' }),
        );

        assert.ok((await listFiles(dir)).includes('Ala'));
        assert.ok((await listFiles(path.join(dir, 'Statusy'))).includes('Ala'));

        const chat = await readState(dir, 'Ala');
        const status = await readState(dir, path.join('Statusy', 'Ala'));
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
            lidToPhone: { '999@lid': '48111222333@c.us' },
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
            lidToPhone: { '999@lid': '48111222333@c.us' },
            broadcasts: [{ msgs: relacje }],
        });

        const archive = new Archive(testConfig(dir, { messagesPerFile: 100 }), client);

        assert.deepEqual(await archive.sweepStatuses(), { saved: 2, skipped: 0 });
        assert.deepEqual(await archive.sweepStatuses(), { saved: 0, skipped: 2 });

        const restarted = new Archive(testConfig(dir, { messagesPerFile: 100 }), client);
        assert.deepEqual(await restarted.sweepStatuses(), { saved: 0, skipped: 2 });

        const state = await readState(dir, path.join('Statusy', '48111222333'));
        assert.equal(state.pendingMessages.length, 2, 'dwie relacje, nie sześć');
        assert.equal(state.seenIds?.length, 2, 'identyfikatory muszą trafić na dysk');
    });
});

test('wiadomość skasowana, gdy jeszcze czeka w partii, dostaje znacznik w stanie', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 100 }),
            fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' } }),
        );

        const message = fakeMessage({ id: 'do-usuniecia', from: '999@lid', body: 'ups' });
        await archive.save(message);
        await archive.markDeleted(message);

        const state = await readState(dir, '48111222333');
        assert.equal(state.pendingMessages[0]?.isDeleted, true);
    });
});

test('wiadomość skasowana po zapisaniu pliku dostaje notkę wprost w HTML', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 1 }),
            fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' } }),
        );

        const message = fakeMessage({ id: 'poszla-do-pliku', from: '999@lid', body: 'żałuję' });
        await archive.save(message);

        const file = path.join(dir, '48111222333', 'messages_0001.html');
        assert.ok(!(await fs.readFile(file, 'utf8')).includes('Skasowana w WhatsAppie'));

        await archive.markDeleted(message);

        const html = await fs.readFile(file, 'utf8');
        assert.ok(html.includes('Skasowana w WhatsAppie'));
        assert.ok(html.includes('żałuję'), 'treść zostaje w archiwum');
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
            lidToPhone: { '999@lid': '48111222333@c.us' },
            contacts: {
                '48111222333@c.us': {
                    id: { _serialized: '48111222333@c.us' },
                    number: '48111222333',
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
            lidToPhone: { '999@lid': '48111222333@c.us' },
            contacts: {
                '48111222333@c.us': { id: { _serialized: '48111222333@c.us' }, number: '48111222333', name: 'Ala', isMyContact: true },
            },
        });
        const archive = new Archive(testConfig(dir, { messagesPerFile: 100 }), client);

        await archive.save(fakeMessage({ id: 'nowa', from: '999@lid', body: 'po przepisaniu' }));

        const folders = await listFiles(dir);
        assert.ok(folders.includes('Ala'), `foldery: ${folders.join(', ')}`);
        assert.ok(!folders.includes('999'), 'stary folder nie zostaje sierotą obok nowego');

        const state = await readState(dir, 'Ala');
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
            fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' } }),
        );
        await archive.save(fakeMessage({ from: '999@lid', body: 'x' }));

        const index = JSON.parse(await fs.readFile(path.join(dir, '_czaty.json'), 'utf8')) as Record<
            string,
            { safeName: string }
        >;

        assert.equal(index['48111222333@c.us']?.safeName, '48111222333');
        assert.equal(index['999@lid']?.safeName, '48111222333', 'wpis jest też pod @lid');
    });
});
