import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Archive } from '../src/archive';
import { checkArchive } from '../src/archiveCheck';
import { log } from '../src/log';
import type { ArchivedMessage, ChatStateFile } from '../src/types';
import { fakeClient, fakeMessage, testConfig, withTempDir } from './helpers';

log.setLevel('error');

test('poprawne archiwum przechodzi kontrolę bez uwag', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(
            testConfig(dir, { messagesPerFile: 1 }),
            fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } }),
        );
        await archive.save(fakeMessage({ id: 'm1', from: '999@lid', body: 'test' }));

        const result = await checkArchive(dir);

        assert.equal(result.chats, 1);
        assert.equal(result.messages, 1);
        assert.equal(result.errors, 0, JSON.stringify(result.issues));
        assert.equal(result.warnings, 0, JSON.stringify(result.issues));
    });
});

test('kontrola wykrywa duplikaty, ucieczkę ścieżki i brak pary JSON do HTML', async () => {
    await withTempDir(async (dir) => {
        const chatDir = path.join(dir, 'Czat');
        await fs.mkdir(chatDir, { recursive: true });
        const duplicate: ArchivedMessage = {
            id: 'powtórka',
            timestamp: 123,
            from: 'Ja',
            fromMe: true,
            avatar: null,
            body: 'test',
            type: 'chat',
            mediaPath: '../../poza.txt',
            mediaName: null,
            mediaSkipped: null,
            isDeleted: false,
            isForwarded: false,
            quotedMsg: null,
            location: null,
            contacts: null,
            poll: null,
        };
        const state: ChatStateFile = {
            chatName: 'Czat',
            nameTier: 3,
            batchNum: 1,
            totalMessages: 1,
            pendingMessages: [duplicate, { ...duplicate }],
            seenIds: ['powtórka', 'powtórka'],
            lastUpdated: new Date(0).toISOString(),
        };
        await fs.writeFile(path.join(chatDir, '_state.json'), JSON.stringify(state), 'utf8');
        await fs.writeFile(path.join(chatDir, 'messages_0001.html'), '<!doctype html>', 'utf8');

        const result = await checkArchive(dir);

        assert.ok(result.errors >= 3, JSON.stringify(result.issues));
        assert.ok(result.warnings >= 2, JSON.stringify(result.issues));
        assert.ok(result.issues.some((item) => item.message.includes('zduplikowane ID')));
        assert.ok(result.issues.some((item) => item.message.includes('wychodzi poza archiwum')));
        assert.ok(result.issues.some((item) => item.message.includes('brakuje danych')));
    });
});

test('brak folderu archiwum jest jednoznacznym błędem', async () => {
    await withTempDir(async (dir) => {
        const result = await checkArchive(path.join(dir, 'nie-istnieje'));

        assert.equal(result.errors, 1);
        assert.match(result.issues[0]?.message ?? '', /nie istnieje/);
    });
});
