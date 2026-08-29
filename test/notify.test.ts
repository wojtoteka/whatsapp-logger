import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Cooldown, Notifier } from '../src/notify';
import { testConfig, withTempDir } from './helpers';

const MINUTE = 60 * 1000;

test('pierwsze powiadomienie przechodzi, drugie w tym samym oknie już nie', async () => {
    await withTempDir(async (dir) => {
        const cooldown = new Cooldown(path.join(dir, 'odstepy.json'), 5 * MINUTE);
        const start = Date.now();

        assert.equal(cooldown.claim('qr', start), true);
        assert.equal(cooldown.claim('qr', start + MINUTE), false);
        assert.equal(cooldown.claim('qr', start + 4 * MINUTE), false);
        assert.equal(cooldown.claim('qr', start + 6 * MINUTE), true);
    });
});

test('każda kategoria alertu ma własny, niezależny odstęp', async () => {
    await withTempDir(async (dir) => {
        const cooldown = new Cooldown(path.join(dir, 'odstepy.json'), 5 * MINUTE);
        const now = Date.now();

        assert.equal(cooldown.claim('qr', now), true);
        assert.equal(cooldown.claim('auth_failure', now), true, 'inna kategoria nie jest blokowana');
        assert.equal(cooldown.claim('qr', now), false);
    });
});

test('odstęp przeżywa restart programu, bo siedzi na dysku', async () => {
    await withTempDir(async (dir) => {
        const file = path.join(dir, 'odstepy.json');
        const now = Date.now();

        assert.equal(new Cooldown(file, 5 * MINUTE).claim('ready', now), true);
        // Nowy obiekt to odpowiednik ponownego uruchomienia programu.
        assert.equal(new Cooldown(file, 5 * MINUTE).claim('ready', now + MINUTE), false);
    });
});

test('uszkodzony plik odstępów nie blokuje powiadomień', async () => {
    await withTempDir(async (dir) => {
        const file = path.join(dir, 'odstepy.json');
        await fs.writeFile(file, 'to nie jest json', 'utf8');

        assert.equal(new Cooldown(file, 5 * MINUTE).claim('qr'), true);
    });
});

test('bez webhooka powiadomienia są wyłączone i nie dotykają sieci ani dysku', async () => {
    await withTempDir(async (dir) => {
        const notifier = new Notifier(testConfig(dir, { discordWebhookUrl: '' }));

        assert.equal(notifier.enabled, false);

        // Żadne z wywołań nie ma prawa rzucić ani nic zapisać.
        await notifier.ready();
        await notifier.qrRequired();
        await notifier.authFailure('test');
        await notifier.disconnected('test');

        assert.deepEqual(await fs.readdir(dir), []);
    });
});

test('ustawiony webhook włącza powiadomienia', async () => {
    await withTempDir(async (dir) => {
        const notifier = new Notifier(
            testConfig(dir, { discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc' }),
        );

        assert.equal(notifier.enabled, true);
    });
});
