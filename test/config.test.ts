import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config';
import { withTempDir } from './helpers';

/** loadConfig czyta .env z podanego katalogu, więc każdy test dostaje swój. */
async function withEnvFile(
    contents: string | null,
    run: (rootDir: string) => Promise<void>,
): Promise<void> {
    await withTempDir(async (dir) => {
        if (contents !== null) await fs.writeFile(path.join(dir, '.env'), contents, 'utf8');
        await run(dir);
    });
}

test('bez pliku .env program dostaje komplet wartości domyślnych', async () => {
    await withEnvFile(null, async (dir) => {
        const { config, envFileFound, warnings } = loadConfig(dir, {});

        assert.equal(envFileFound, false);
        assert.deepEqual(warnings, []);
        assert.equal(config.qrMaxCodes, 3);
        assert.equal(config.messagesPerFile, 70);
        assert.equal(config.backfillMessagesPerChat, 250);
        assert.equal(config.retentionDays, 180);
        assert.equal(config.saveProfilePics, true);
        assert.equal(config.saveAiChat, false);
        assert.equal(config.logsDir, path.resolve(dir, './logs'));
        assert.equal(config.lockedChatPassword, '');
        assert.equal(config.tauEnabled, false);
        assert.equal(config.tauProviderNumber, '18002428478');
    });
});

test('QR_MAX_CODES daje się podnieść i wyłączyć zerem', async () => {
    await withEnvFile('QR_MAX_CODES=10\n', async (dir) => {
        const { config, warnings } = loadConfig(dir, { QR_MAX_CODES: '10' });

        assert.equal(config.qrMaxCodes, 10);
        assert.deepEqual(warnings, []);
    });

    await withEnvFile('QR_MAX_CODES=0\n', async (dir) => {
        const { config } = loadConfig(dir, { QR_MAX_CODES: '0' });

        assert.equal(config.qrMaxCodes, 0);
    });
});

test('?tau jest opcjonalne, normalizuje numer i nie pozwala przekroczyć 200 wiadomości', async () => {
    await withEnvFile('TAU_ENABLED=true\nTAU_PROVIDER_NUMBER=+1 800 242 8478\nTAU_MAX_MESSAGES=999\n', async (dir) => {
        const { config, warnings } = loadConfig(dir, {
            TAU_ENABLED: 'true',
            TAU_PROVIDER_NUMBER: '+1 800 242 8478',
            TAU_MAX_MESSAGES: '999',
        });

        assert.equal(config.tauEnabled, true);
        assert.equal(config.tauProviderNumber, '18002428478');
        assert.equal(config.tauMaxMessages, 200);
        assert.ok(warnings.some((warning) => warning.includes('TAU_MAX_MESSAGES')));
    });
});

test('SAVE_AI_CHAT wymaga świadomego włączenia archiwizacji AI i jest znanym kluczem', async () => {
    await withEnvFile('SAVE_AI_CHAT=true\n', async (dir) => {
        const { config, warnings } = loadConfig(dir, { SAVE_AI_CHAT: 'true' });

        assert.equal(config.saveAiChat, true);
        assert.equal(config.tauEnabled, false);
        assert.deepEqual(warnings, []);
    });
});

test('wyłączenie archiwizacji AI nie wyłącza ?tau ani nie zależy od kanałów', async () => {
    await withEnvFile('SAVE_AI_CHAT=false\nTAU_ENABLED=true\nSAVE_CHANNELS=true\n', async (dir) => {
        const { config, warnings } = loadConfig(dir, {
            SAVE_AI_CHAT: 'false',
            TAU_ENABLED: 'true',
            SAVE_CHANNELS: 'true',
        });

        assert.equal(config.saveAiChat, false);
        assert.equal(config.tauEnabled, true);
        assert.equal(config.saveChannels, true);
        assert.deepEqual(warnings, []);
    });
});

test('błędne SAVE_AI_CHAT zostawia archiwizację AI wyłączoną i zgłasza uwagę', async () => {
    await withEnvFile('SAVE_AI_CHAT=może\n', async (dir) => {
        const { config, warnings } = loadConfig(dir, { SAVE_AI_CHAT: 'może' });

        assert.equal(config.saveAiChat, false);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /SAVE_AI_CHAT/);
    });
});

test('wartości z .env nadpisują domyślne, a ścieżka archiwum jest bezwzględna', async () => {
    await withEnvFile(
        [
            'MESSAGES_PER_FILE=25',
            'BACKFILL_MESSAGES_PER_CHAT=400',
            'RETENTION_ENABLED=false',
            'SAVE_PROFILE_PICS=nie',
            'LOGS_DIR=./archiwum',
            'MEDIA_TYPES=image, ptt',
        ].join('\n'),
        async (dir) => {
            const { config, warnings } = loadConfig(dir, {
                MESSAGES_PER_FILE: '25',
                BACKFILL_MESSAGES_PER_CHAT: '400',
                RETENTION_ENABLED: 'false',
                SAVE_PROFILE_PICS: 'nie',
                LOGS_DIR: './archiwum',
                MEDIA_TYPES: 'image, ptt',
            });

            assert.deepEqual(warnings, []);
            assert.equal(config.messagesPerFile, 25);
            assert.equal(config.backfillMessagesPerChat, 400);
            assert.equal(config.retentionEnabled, false);
            assert.equal(config.saveProfilePics, false);
            assert.equal(config.logsDir, path.resolve(dir, './archiwum'));
            assert.deepEqual([...config.mediaTypes].sort(), ['image', 'ptt']);
        },
    );
});

test('liczba poza zakresem zostaje przycięta i zgłoszona, zamiast wywrócić program', async () => {
    await withEnvFile('MESSAGES_PER_FILE=0\n', async (dir) => {
        const { config, warnings } = loadConfig(dir, { MESSAGES_PER_FILE: '0' });

        assert.equal(config.messagesPerFile, 1);
        assert.ok(warnings.some((w) => w.includes('MESSAGES_PER_FILE')));
    });
});

test('bzdura zamiast liczby albo wartości logicznej spada na wartość domyślną', async () => {
    await withEnvFile('MESSAGES_PER_FILE=dużo\nHEADLESS=może\n', async (dir) => {
        const { config, warnings } = loadConfig(dir, {
            MESSAGES_PER_FILE: 'dużo',
            HEADLESS: 'może',
        });

        assert.equal(config.messagesPerFile, 70);
        assert.equal(config.headless, true);
        assert.equal(warnings.length, 2);
    });
});

test('nieznany typ mediów jest pomijany, a literówka w kluczu zgłaszana', async () => {
    await withEnvFile('MEDIA_TYPES=image,hologram\nMESAGES_PER_FILE=10\n', async (dir) => {
        const { config, warnings } = loadConfig(dir, { MEDIA_TYPES: 'image,hologram' });

        assert.deepEqual([...config.mediaTypes], ['image']);
        assert.ok(warnings.some((w) => w.includes('hologram')));
        assert.ok(warnings.some((w) => w.includes('MESAGES_PER_FILE')));
    });
});

test('MEDIA_TYPES=brak wyłącza pobieranie plików bez wyłączania reszty', async () => {
    await withEnvFile('MEDIA_TYPES=brak\n', async (dir) => {
        const { config } = loadConfig(dir, { MEDIA_TYPES: 'brak' });

        assert.equal(config.mediaTypes.size, 0);
        assert.equal(config.saveStatuses, true);
    });
});

test('ping Discorda bez webhooka to ostrzeżenie, nie cicha strata powiadomień', async () => {
    await withEnvFile('DISCORD_PING_USER_ID=123456\n', async (dir) => {
        const { warnings } = loadConfig(dir, { DISCORD_PING_USER_ID: '123456' });

        assert.ok(warnings.some((w) => w.includes('DISCORD_PING_USER_ID')));
    });
});

test('adres webhooka spoza Discorda zostaje zgłoszony', async () => {
    await withEnvFile('DISCORD_WEBHOOK_URL=https://example.com/hook\n', async (dir) => {
        const { warnings } = loadConfig(dir, {
            DISCORD_WEBHOOK_URL: 'https://example.com/hook',
        });

        assert.ok(warnings.some((w) => w.includes('DISCORD_WEBHOOK_URL')));
    });
});

test('poprawny webhook Discorda przechodzi bez uwag', async () => {
    const url = 'https://discord.com/api/webhooks/123/abc';
    await withEnvFile(`DISCORD_WEBHOOK_URL=${url}\n`, async (dir) => {
        const { config, warnings } = loadConfig(dir, { DISCORD_WEBHOOK_URL: url });

        assert.equal(config.discordWebhookUrl, url);
        assert.deepEqual(warnings, []);
    });
});

test('domyślnie panel nasłuchuje tylko na tej maszynie', async () => {
    await withEnvFile(null, async (dir) => {
        const { config } = loadConfig(dir, {});
        assert.equal(config.panelHost, '127.0.0.1');
    });
});

test('PANEL_HOST przyjmuje pętlę zwrotną, wszystkie karty i konkretne IP', async () => {
    for (const adres of ['127.0.0.1', '0.0.0.0', 'host-w-sieci.lan', 'archiwum.lan']) {
        await withEnvFile(`PANEL_HOST=${adres}
`, async (dir) => {
            const { config, warnings } = loadConfig(dir, { PANEL_HOST: adres });

            assert.equal(config.panelHost, adres);
            assert.deepEqual(warnings, [], `${adres} to poprawny adres, nie ma o czym ostrzegać`);
        });
    }
});

test('PANEL_HOST z http:// albo z portem to ostrzeżenie, nie cicha awaria', async () => {
    for (const zly of ['http://host-w-sieci.lan', 'host-w-sieci.lan:3000', '0.0.0.0/24']) {
        await withEnvFile(`PANEL_HOST=${zly}
`, async (dir) => {
            const { warnings } = loadConfig(dir, { PANEL_HOST: zly });

            assert.equal(warnings.length, 1, `${zly} powinno dać dokładnie jedno ostrzeżenie`);
            assert.match(String(warnings[0]), /PANEL_HOST/);
        });
    }
});
