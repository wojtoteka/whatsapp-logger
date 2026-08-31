import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Archive } from '../src/archive';
import { log } from '../src/log';
import { MediaRetryQueue } from '../src/mediaRetry';
import type { BatchFile } from '../src/types';
import { fakeClient, fakeMessage, testConfig, withTempDir } from './helpers';

log.setLevel('error');

test('kolejka nie dubluje wiadomości i odpuszcza po ośmiu podejściach', async () => {
    await withTempDir(async (dir) => {
        const queue = new MediaRetryQueue(dir);

        await queue.add({ chatId: '5550100@c.us', messageId: 'foto', type: 'image', reason: 'nie udało się pobrać pliku' });
        await queue.add({ chatId: '5550100@c.us', messageId: 'foto', type: 'image', reason: 'nie udało się pobrać pliku' });
        await queue.add({ chatId: '5550100@c.us', messageId: 'film', type: 'video', reason: 'nie udało się pobrać pliku' });

        assert.equal(await queue.size(), 2, 'ta sama wiadomość wchodzi do kolejki raz');
        assert.deepEqual(
            (await queue.due(10)).map((entry) => entry.messageId),
            ['foto', 'film'],
        );

        // Ograniczenie liczby podejść: po ósmym wpis przestaje się kwalifikować.
        for (let i = 0; i < 8; i++) await queue.markAttempt('foto');
        assert.deepEqual(
            (await queue.due(10)).map((entry) => entry.messageId),
            ['film'],
        );

        assert.equal(await queue.prune(), 1);
        assert.equal(await queue.size(), 1);

        await queue.remove('film');
        assert.equal(await queue.size(), 0);

        // Kolejka przeżywa restart - to zwykły plik w folderze archiwum.
        await new MediaRetryQueue(dir).add({
            chatId: '5550100@c.us',
            messageId: 'nagranie',
            type: 'ptt',
            reason: 'nie udało się pobrać pliku',
        });
        assert.equal(await new MediaRetryQueue(dir).size(), 1);
    });
});

test('plik, którego WhatsApp nie oddał, zostaje odzyskany przy kolejnym przeglądzie', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
        // Pierwsze podejście: WhatsApp oddaje pustkę, dokładnie jak przy
        // wygasłym pliku czekającym na ponowne wysłanie przez telefon.
        const message = fakeMessage({
            id: 'foto',
            from: '999@lid',
            type: 'image',
            hasMedia: true,
            body: 'podpis pod zdjęciem',
        });

        const archive = new Archive(testConfig(dir, { messagesPerFile: 1 }), client);
        assert.equal(await archive.save(message), true);

        const batchFile = path.join(dir, '5550100', 'messages_0001.json');
        const first = JSON.parse(await fs.readFile(batchFile, 'utf8')) as BatchFile;
        assert.equal(first.messages[0]?.mediaPath, null);
        // Notatka zaczyna się tak, jak rozpoznaje ją isRecoverableMediaFailure,
        // a dalej niesie powód prosto z przeglądarki - stąd sam przedrostek.
        assert.match(first.messages[0]?.mediaSkipped?.reason ?? '', /^nie udało się pobrać pliku/);

        // Telefon wysłał plik ponownie - ta sama wiadomość, tym razem z danymi.
        const znowu = fakeMessage({
            id: 'foto',
            from: '999@lid',
            type: 'image',
            hasMedia: true,
            body: 'podpis pod zdjęciem',
        });
        (znowu as unknown as { downloadMedia: () => Promise<unknown> }).downloadMedia = async () => ({
            data: Buffer.from('zawartość zdjęcia').toString('base64'),
            mimetype: 'image/jpeg',
        });
        (client as unknown as { getMessageById: (id: string) => Promise<unknown> }).getMessageById =
            async (id: string) => (id === 'foto' ? znowu : null);

        assert.deepEqual(await archive.retryFailedMedia(), { tried: 1, recovered: 1, waiting: 0 });

        const patched = JSON.parse(await fs.readFile(batchFile, 'utf8')) as BatchFile;
        const odzyskana = patched.messages[0];
        assert.ok(odzyskana?.mediaPath, 'wiadomość ma teraz ścieżkę do pliku');
        assert.equal(odzyskana?.mediaSkipped, null, 'notatka o porażce znika');

        const saved = await fs.readFile(
            path.resolve(dir, '5550100', odzyskana?.mediaPath ?? ''),
            'utf8',
        );
        assert.equal(saved, 'zawartość zdjęcia');

        // Plik HTML powstaje od nowa z tej samej partii, więc widać w nim obraz,
        // a nie notatkę "Nie zapisano pliku".
        const html = await fs.readFile(path.join(dir, '5550100', 'messages_0001.html'), 'utf8');
        assert.ok(html.includes((odzyskana?.mediaPath ?? '').replace(/\\/g, '/')));
        assert.ok(!html.includes('Nie zapisano pliku'));
        assert.ok(html.includes('podpis pod zdjęciem'), 'reszta partii zostaje nietknięta');
    });
});

test('bez pliku po stronie WhatsAppa wiadomość zostaje w kolejce na kolejny raz', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
        const archive = new Archive(testConfig(dir, { messagesPerFile: 1 }), client);

        await archive.save(
            fakeMessage({ id: 'foto', from: '999@lid', type: 'image', hasMedia: true }),
        );

        // WhatsApp nie zna już tej wiadomości - nie ma z czego pobierać.
        (client as unknown as { getMessageById: (id: string) => Promise<unknown> }).getMessageById =
            async () => null;

        assert.deepEqual(await archive.retryFailedMedia(), { tried: 1, recovered: 0, waiting: 1 });

        const queue = await new MediaRetryQueue(dir).due(10);
        assert.equal(queue[0]?.messageId, 'foto');
        assert.equal(queue[0]?.attempts, 1);
    });
});

test('relacja z kolejki jest szukana wśród statusów, nie przez getMessageById', async () => {
    await withTempDir(async (dir) => {
        const client = fakeClient();
        const archive = new Archive(testConfig(dir, { messagesPerFile: 1 }), client);

        // Relacja z niepobranym plikiem trafia do kolejki tak samo jak zdjęcie
        // z rozmowy - jej klucz czatu ma tylko przedrostek "status:".
        await archive.save(
            fakeMessage({
                id: 'relacja-1',
                rawStatusId: true,
                from: '5550100@c.us',
                type: 'image',
                hasMedia: true,
            }),
        );

        let pytanoOWiadomosc = false;
        let pytanoOStatusy = false;
        const stub = client as unknown as Record<string, unknown>;
        // getMessageById() zagląda wyłącznie do Store.Msg, gdzie relacji nie ma.
        // Sięgnięcie po nie dla relacji było właśnie tym błędem: każde ponowienie
        // wracało z pustką i po ośmiu podejściach relacja wypadała z kolejki.
        stub.getMessageById = async (): Promise<unknown> => {
            pytanoOWiadomosc = true;
            return null;
        };
        stub.pupPage = {
            async evaluate(): Promise<unknown> {
                pytanoOStatusy = true;
                return [];
            },
        };

        assert.deepEqual(await archive.retryFailedMedia(), { tried: 1, recovered: 0, waiting: 1 });
        assert.equal(pytanoOStatusy, true, 'ponowienie zagląda do kolekcji relacji');
        assert.equal(pytanoOWiadomosc, false, 'i nie pyta o relację jak o zwykłą wiadomość');
    });
});
