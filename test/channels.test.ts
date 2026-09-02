import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Archive } from '../src/archive';
import { isChannelId, isChannelMessage } from '../src/channels';
import { loadConfig } from '../src/config';
import { log } from '../src/log';
import { fakeClient, fakeMessage, testConfig, withTempDir } from './helpers';

log.setLevel('error');

const KANAL = '120363000000000000@newsletter';

test('kanał poznajemy po domenie identyfikatora, a rozmowy i grupy nie', () => {
    assert.equal(isChannelId(KANAL), true);
    assert.equal(isChannelId('120363000000000000@g.us'), false);
    assert.equal(isChannelId('5550100@c.us'), false);
    assert.equal(isChannelId('999@lid'), false);
    assert.equal(isChannelId('status@broadcast'), false);
    assert.equal(isChannelId(null), false);
    assert.equal(isChannelId(''), false);
});

test('wiadomość z kanału jest rozpoznawana po każdym polu, w którym stoi jego identyfikator', () => {
    assert.equal(isChannelMessage(fakeMessage({ from: KANAL })), true);
    assert.equal(isChannelMessage(fakeMessage({ to: KANAL, fromMe: true })), true);
    assert.equal(isChannelMessage(fakeMessage({ author: KANAL })), true);

    const zwykla = fakeMessage({ from: '5550100@c.us' });
    assert.equal(isChannelMessage(zwykla), false);
    assert.equal(isChannelMessage(null), false);
});

test('kanał ukryty w id.remote też zostaje rozpoznany', () => {
    const message = fakeMessage({ from: '5550100@c.us' });
    (message as unknown as { id: { remote: unknown } }).id.remote = { _serialized: KANAL };

    assert.equal(isChannelMessage(message), true);
});

test('SAVE_CHANNELS jest domyślnie wyłączone i daje się włączyć', async () => {
    await withTempDir(async (dir) => {
        assert.equal(loadConfig(dir, {}).config.saveChannels, false);
        assert.equal(loadConfig(dir, { SAVE_CHANNELS: 'true' }).config.saveChannels, true);
    });
});

test('wiadomość z kanału nie trafia do archiwum ani nie zakłada folderu', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir), fakeClient());

        const saved = await archive.save(
            fakeMessage({ from: KANAL, body: 'reklama', hasMedia: true, type: 'video' }),
        );

        assert.equal(saved, false);
        assert.deepEqual(await fs.readdir(dir).catch(() => []), []);
    });
});

test('SAVE_CHANNELS=true przywraca archiwizowanie kanałów', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir, { saveChannels: true }), fakeClient());

        const saved = await archive.save(fakeMessage({ from: KANAL, body: 'reklama' }));

        assert.equal(saved, true);
        const folders = await fs.readdir(dir);
        assert.equal(folders.length, 2, 'folder kanału i spis czatów');
        assert.ok(await fs.readFile(path.join(dir, '_czaty.json'), 'utf8'));
    });
});

test('nadrabianie w ogóle nie otwiera kanałów', async () => {
    await withTempDir(async (dir) => {
        const otwarte: string[] = [];
        const client = fakeClient();

        // Lista idzie wprost ze strony, więc zbiorcze getChats ma nie być
        // potrzebne - jest tu tylko po to, żeby nadrabianie w ogóle ruszyło.
        client.getChats = async () => {
            throw new Error('r: r');
        };

        // Pierwsze zapytanie do strony to lista czatów - tą drogą idzie
        // nadrabianie. Reszta odczytów ze strony ma tu nic nie wnosić.
        let calls = 0;
        client.pupPage = {
            evaluate: async () => {
                calls++;
                if (calls === 1) {
                    return [
                        { id: KANAL, name: 'Kanał', lastActivity: 1, unread: 0 },
                        { id: '5550100@c.us', name: 'Kontakt', lastActivity: 1, unread: 0 },
                    ];
                }
                return null;
            },
        } as unknown as NonNullable<typeof client.pupPage>;

        client.getChatById = async (id: string) => {
            otwarte.push(id);
            return {
                id: { _serialized: id },
                fetchMessages: async () => [],
            } as unknown as Awaited<ReturnType<typeof client.getChatById>>;
        };

        const archive = new Archive(testConfig(dir), client);
        await archive.backfillRecent(25, { includeNewChats: true });

        assert.ok(otwarte.includes('5550100@c.us'), 'zwykła rozmowa ma zostać otwarta');
        assert.equal(otwarte.includes(KANAL), false, 'kanał nie ma prawa zostać otwarty');
    });
});
