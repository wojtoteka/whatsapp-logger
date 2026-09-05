import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Archive } from '../src/archive';
import type { Database } from '../src/db';
import { IdentityResolver } from '../src/identity';
import { IgnoredChats, isIgnoredChatId } from '../src/ignoredChats';
import { log } from '../src/log';
import { MediaRetryQueue } from '../src/mediaRetry';
import type { AvatarRecord, ChatIndexEntry, WaClient, WaMessage } from '../src/types';
import { fakeClient, fakeMessage, testConfig, withTempDir } from './helpers';

log.setLevel('error');

const OFFICIAL_IDS = ['0@c.us', '0@s.whatsapp.net'];
const AI_IDS = ['18002428478@c.us', '18002428478@s.whatsapp.net'];
const IGNORED_IDS = [...OFFICIAL_IDS, ...AI_IDS];
const CONTACT = '48123456789@c.us';

/** Porównujemy również listę plików, żeby wykryć np. dopisanie _deleted.log. */
async function snapshot(dir: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            for (const [nested, contents] of Object.entries(await snapshot(file))) {
                files[path.join(entry.name, nested)] = contents;
            }
        } else {
            files[entry.name] = await fs.readFile(file, 'base64');
        }
    }
    return files;
}

async function writeIndex(dir: string, ids: readonly string[]): Promise<void> {
    const index: Record<string, ChatIndexEntry> = {};
    for (const [position, id] of ids.entries()) {
        const safeName = `czat-${position}`;
        index[id] = { name: `Kontakt ${position}`, safeName, tier: 0 };
        await fs.mkdir(path.join(dir, safeName), { recursive: true });
    }
    await fs.writeFile(path.join(dir, '_czaty.json'), JSON.stringify(index));
}

test('oficjalne konto jest zawsze pomijane, ChatGPT zależy tylko od SAVE_AI_CHAT', () => {
    for (const id of OFFICIAL_IDS) {
        assert.equal(isIgnoredChatId(id), true, id);
        assert.equal(isIgnoredChatId(id, true), true, id);
    }
    for (const id of AI_IDS) {
        assert.equal(isIgnoredChatId(id), true, id);
        assert.equal(isIgnoredChatId(id, true), false, id);
    }
    for (const id of [CONTACT, '18002428479@c.us', '0@g.us', '18002428478@g.us', '999@lid', '']) {
        assert.equal(isIgnoredChatId(id), false, id);
    }
});

for (const source of ['from', 'to', 'remote-string', 'remote-object'] as const) {
    test(`ignorowanie wiadomości działa dla identyfikatora w ${source}, zanim ruszy pobieranie mediów`, async () => {
        await withTempDir(async (dir) => {
            let downloads = 0;
            for (const saveAiChat of [false, true]) {
                const archive = new Archive(testConfig(dir, { saveChannels: true, saveAiChat }), fakeClient());
                for (const id of saveAiChat ? OFFICIAL_IDS : IGNORED_IDS) {
                    const message = fakeMessage({
                        from: source === 'from' ? id : CONTACT,
                        to: source === 'to' ? id : 'me@c.us',
                        fromMe: source === 'to',
                        body: 'Nie archiwizuj',
                        hasMedia: true,
                        type: 'image',
                    });
                    if (source.startsWith('remote')) {
                        (message as unknown as { id: { remote: unknown } }).id.remote =
                            source === 'remote-object' ? { _serialized: id } : id;
                    }
                    message.downloadMedia = async () => {
                        downloads++;
                        throw new Error('ignorowana wiadomość nie powinna pobierać mediów');
                    };
                    assert.equal(await archive.save(message), false, `${id}, saveAiChat=${saveAiChat}`);
                }
            }
            assert.equal(downloads, 0);
            assert.deepEqual(await fs.readdir(dir), [], 'ignorowane wiadomości nie tworzą żadnego archiwum');
        });
    });
}

test('SAVE_AI_CHAT=true pozwala zapisywać przychodzące i wychodzące wiadomości ChatGPT', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir, { saveAiChat: true }), fakeClient());
        for (const [position, id] of AI_IDS.entries()) {
            for (const fromMe of [false, true]) {
                assert.equal(await archive.save(fakeMessage({
                    id: `ai-${position}-${fromMe}`,
                    from: fromMe ? 'me@c.us' : id,
                    to: fromMe ? id : 'me@c.us',
                    fromMe,
                    body: 'Zapisywanie AI jest włączone',
                })), true);
            }
        }
        assert.ok((await fs.readdir(dir)).includes('_czaty.json'));
    });
});

for (const lookup of ['lidToPhone', 'contact.number'] as const) {
    test(`ignorowane konta są rozpoznawane także przez ${lookup}`, async () => {
        await withTempDir(async (dir) => {
            for (const [position, id] of [...AI_IDS, ...OFFICIAL_IDS].entries()) {
                const lid = `${990000 + position}@lid`;
                const client = fakeClient(lookup === 'lidToPhone'
                    ? { lidToPhone: { [lid]: id } }
                    : { contacts: { [lid]: { id: { _serialized: lid }, number: id.split('@')[0] } } });
                const archive = new Archive(testConfig(dir), client);
                for (const fromMe of [false, true]) {
                    assert.equal(await archive.save(fakeMessage({
                        from: fromMe ? 'me@c.us' : lid,
                        to: fromMe ? lid : 'me@c.us',
                        fromMe,
                        body: 'Ukryty numer',
                    })), false, `${id}, fromMe=${fromMe}`);
                }
            }
            assert.deepEqual(await fs.readdir(dir), []);
        });
    });
}

test('numer ChatGPT z kontaktu wiadomości też jest pomijany, a SAVE_AI_CHAT dopuszcza jego LID', async () => {
    await withTempDir(async (dir) => {
        const lid = '999999@lid';
        const message = fakeMessage({
            from: lid, body: 'Odpowiedź AI',
            contact: { id: { _serialized: lid }, number: '18002428478' },
        });
        assert.equal(await new Archive(testConfig(dir), fakeClient()).save(message), false);
        assert.deepEqual(await fs.readdir(dir), []);

        const enabled = new Archive(testConfig(dir, { saveAiChat: true }), fakeClient({
            lidToPhone: { [lid]: AI_IDS[0]! },
        }));
        assert.equal(await enabled.save(message), true);
    });
});

test('nierozwiązany LID jest sprawdzany raz, a synchronizacja pozwala rozpoznać później numer AI', async () => {
    await withTempDir(async (dir) => {
        const lid = '998877@lid';
        const client = fakeClient();
        let lookupCount = 0;
        let phone = '';
        client.getContactLidAndPhone = async (ids) => {
            lookupCount++;
            return ids.map((id) => ({ lid: id, pn: phone }));
        };
        const ignored = new IgnoredChats(testConfig(dir), new IdentityResolver(client), new Map());
        for (let i = 0; i < 100; i++) assert.equal(await ignored.has(lid), false);
        assert.equal(lookupCount, 1, 'kolejne wiadomości nie pytają sto razy o ten sam nieznany numer');

        const archive = new Archive(testConfig(dir), client);
        assert.equal(await archive.save(fakeMessage({ id: 'przed-sync', from: lid, body: 'Nieznany kontakt' })), true);
        const before = await snapshot(dir);
        const previousCount = lookupCount;
        phone = AI_IDS[0]!;
        archive.refreshAfterSync();

        assert.equal(await archive.save(fakeMessage({ id: 'po-sync', from: lid, body: 'To jest ChatGPT' })), false);
        assert.ok(lookupCount > previousCount, 'po synchronizacji numer jest odczytywany ponownie');
        assert.deepEqual(await snapshot(dir), before, 'rozpoznane AI nie dopisuje nowej wiadomości');
    });
});

test('zwykłe rozmowy, ich nazwy i autor AI w grupie nie są podstawą do ignorowania', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir), fakeClient());
        const messages = [
            fakeMessage({ id: 'zwykla', from: CONTACT, chatName: 'WhatsApp', body: 'Cześć' }),
            fakeMessage({ id: 'podobny-numer', from: '18002428479@c.us', chatName: 'ChatGPT', body: 'Cześć' }),
            fakeMessage({
                id: 'grupa-ai', from: '120363000000000000@g.us', author: AI_IDS[0],
                contact: { id: { _serialized: AI_IDS[0]! }, number: '18002428478' },
                chatName: 'Grupa', body: 'Wiadomość na grupie',
            }),
        ];
        for (const message of messages) assert.equal(await archive.save(message), true);
    });
});

for (const listing of ['raw', 'getChats', 'index-fallback'] as const) {
    test(`nadrabianie (${listing}) pomija konta i ich aliasy przed otwieraniem oraz synchronizacją`, async () => {
        await withTempDir(async (dir) => {
            const aliases = IGNORED_IDS.map((_, i) => `${880000 + i}@lid`);
            await writeIndex(dir, [...IGNORED_IDS, CONTACT]);
            const indexFile = path.join(dir, '_czaty.json');
            const index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as Record<string, ChatIndexEntry>;
            aliases.forEach((alias, i) => { index[alias] = index[IGNORED_IDS[i]!]!; });
            await fs.writeFile(indexFile, JSON.stringify(index));
            const before = await snapshot(dir);
            const opened: string[] = [];
            const synced: string[] = [];
            const fetched: string[] = [];
            let getChatsCalls = 0;
            const client = fakeClient();
            const chat = (id: string): Awaited<ReturnType<WaClient['getChatById']>> => ({
                id: { _serialized: id },
                name: id,
                syncHistory: async () => { synced.push(id); return false; },
                fetchMessages: async () => { fetched.push(id); return []; },
            }) as unknown as Awaited<ReturnType<WaClient['getChatById']>>;
            client.getChatById = async (id) => { opened.push(id); return chat(id); };
            client.syncHistory = async (id) => { synced.push(id); return false; };
            client.getChats = async () => {
                getChatsCalls++;
                if (listing !== 'getChats') throw new Error('lista niedostępna');
                return [...IGNORED_IDS, ...aliases, CONTACT].map(chat);
            };
            if (listing === 'raw') {
                let evaluations = 0;
                client.pupPage = {
                    evaluate: async () => ++evaluations === 1
                        ? [...IGNORED_IDS, ...aliases, CONTACT].map((id) => ({ id, name: id, lastActivity: 1, unread: 0 }))
                        : null,
                } as unknown as NonNullable<WaClient['pupPage']>;
            }

            const archive = new Archive(testConfig(dir, { saveChannels: true }), client);
            const stats = await archive.backfillRecent(25, { includeNewChats: true });

            assert.equal(stats.chats, 1);
            assert.deepEqual(fetched, [CONTACT]);
            assert.deepEqual(synced, [CONTACT]);
            assert.deepEqual(opened, listing === 'getChats' ? [] : [CONTACT]);
            assert.equal(getChatsCalls, listing === 'raw' ? 0 : 1);
            assert.deepEqual(await snapshot(dir), before);
        });
    });
}

test('getChats odrzuca także wcześniejszy alias, gdy dopiero drugi LID ujawnia numer AI', async () => {
    await withTempDir(async (dir) => {
        const firstLid = '123001@lid';
        const secondLid = '123002@lid';
        await writeIndex(dir, [firstLid, CONTACT]);
        const indexFile = path.join(dir, '_czaty.json');
        const index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as Record<string, ChatIndexEntry>;
        index[secondLid] = index[firstLid]!;
        await fs.writeFile(indexFile, JSON.stringify(index));
        const before = await snapshot(dir);
        const synced: string[] = [];
        const fetched: string[] = [];
        const opened: string[] = [];
        const client = fakeClient({ lidToPhone: { [secondLid]: AI_IDS[0]! } });
        client.getChats = async () => [firstLid, secondLid, CONTACT].map((id) => ({
            id: { _serialized: id },
            name: id,
            syncHistory: async () => { synced.push(id); return false; },
            fetchMessages: async () => { fetched.push(id); return []; },
        })) as unknown as Awaited<ReturnType<WaClient['getChats']>>;
        client.getChatById = async (id) => {
            opened.push(id);
            throw new Error('gotowy czat z getChats nie wymaga otwierania');
        };
        const archive = new Archive(testConfig(dir), client);

        const stats = await archive.backfillRecent(25, { includeNewChats: true });

        assert.equal(stats.chats, 1);
        assert.deepEqual(synced, [CONTACT]);
        assert.deepEqual(fetched, [CONTACT]);
        assert.deepEqual(opened, []);
        assert.deepEqual(await snapshot(dir), before);
    });
});

test('kolejka mediów usuwa ignorowane zaległości przed getMessageById i pobieraniem', async () => {
    await withTempDir(async (dir) => {
        const lid = '777777@lid';
        await writeIndex(dir, [...IGNORED_IDS, lid]);
        const queue = new MediaRetryQueue(dir);
        for (const [i, chatId] of [...IGNORED_IDS, lid].entries()) {
            await queue.add({ chatId, messageId: `foto-${i}`, type: 'image', reason: 'nie udało się pobrać pliku' });
        }
        let reads = 0;
        const client = fakeClient({ lidToPhone: { [lid]: AI_IDS[0]! } });
        client.getMessageById = async () => { reads++; return null as unknown as WaMessage; };
        const archive = new Archive(testConfig(dir, { saveChannels: true }), client);

        assert.deepEqual(await archive.retryFailedMedia(), { tried: 0, recovered: 0, waiting: 0 });
        assert.equal(reads, 0);
        assert.equal(await new MediaRetryQueue(dir).size(), 0);
    });
});

for (const existing of [false, true]) {
    test(`zdarzenia usunięcia i doręczenia ignorowanych rozmów nie zapisują bazy ani plików (istniejące=${existing})`, async () => {
        await withTempDir(async (dir) => {
            for (const id of IGNORED_IDS) {
                const archiveDir = path.join(dir, id.replace(/[^a-z0-9]/g, '_'));
                await fs.mkdir(archiveDir);
                if (existing) {
                    // Tworzymy prawidłowe stare archiwum, zanim podmienimy jego
                    // identyfikator na konto objęte nową zasadą ignorowania.
                    const previous = new Archive(testConfig(archiveDir, { messagesPerFile: 1 }), fakeClient());
                    await previous.save(fakeMessage({
                        id: 'stara-wiadomosc', from: 'me@c.us', to: CONTACT,
                        fromMe: true, ack: 1, body: 'Treść już jest na dysku',
                    }));
                    const indexFile = path.join(archiveDir, '_czaty.json');
                    const index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as Record<string, ChatIndexEntry>;
                    await fs.writeFile(indexFile, JSON.stringify({ [id]: index[CONTACT] }));
                }
                let writes = 0;
                const db = {
                    markDeleted: async () => { writes++; },
                    markAck: async () => { writes++; },
                    saveMessage: async () => { writes++; },
                } as unknown as Database;
                const archive = new Archive(testConfig(archiveDir), fakeClient(), db);
                const before = await snapshot(archiveDir);
                const message = fakeMessage({
                    id: 'stara-wiadomosc', from: 'me@c.us', to: id, fromMe: true,
                });

                assert.equal(await archive.markDeleted(message), false, id);
                assert.equal(await archive.markAck(message, 3), false, id);
                assert.equal(writes, 0, id);
                assert.deepEqual(await snapshot(archiveDir), before, id);
            }
        });
    });
}

test('odświeżanie awatarów pomija indeks i samą historię, także po rozpoznaniu LID', async () => {
    await withTempDir(async (dir) => {
        const lid = '666666@lid';
        await writeIndex(dir, [OFFICIAL_IDS[0]!, AI_IDS[0]!, CONTACT]);
        const historyFile = path.join(dir, '_avatars', '_historia.json');
        await fs.mkdir(path.dirname(historyFile));
        const history = Object.fromEntries([...IGNORED_IDS, lid].map((id) => [id, {
            checkedAt: '2020-01-01T00:00:00.000Z', versions: [],
        } satisfies AvatarRecord]));
        await fs.writeFile(historyFile, JSON.stringify(history));
        const requested: string[] = [];
        const client = fakeClient({ lidToPhone: { [lid]: AI_IDS[0]! } });
        client.getProfilePicUrl = async (id) => { requested.push(id); return ''; };
        const archive = new Archive(testConfig(dir, { saveProfilePics: true }), client);

        assert.deepEqual(await archive.refreshAvatars(), { checked: 1, changed: 0 });
        assert.deepEqual(requested, [CONTACT]);
        const refreshed = JSON.parse(await fs.readFile(historyFile, 'utf8')) as Record<string, AvatarRecord>;
        for (const [id, record] of Object.entries(history)) assert.deepEqual(refreshed[id], record, id);
    });
});
