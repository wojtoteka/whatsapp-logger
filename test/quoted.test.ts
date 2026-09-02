import test from 'node:test';
import assert from 'node:assert/strict';
import { Archive } from '../src/archive';
import { log } from '../src/log';
import { hasQuotedHint, readQuotedFromStore } from '../src/quoted';
import { fakeClient, fakeMessage, testConfig, withTempDir } from './helpers';

log.setLevel('error');

test('zwykła wiadomość nie kosztuje ani jednego zapytania do przeglądarki', () => {
    assert.equal(hasQuotedHint(fakeMessage({ body: 'cześć' })), false);
    assert.equal(hasQuotedHint(null), false);
});

test('ślad odpowiedzi widać także wtedy, gdy hasQuotedMsg kłamie', () => {
    // Tak wygląda wiadomość po serialize() w tym wydaniu WhatsApp Weba:
    // pola quotedMsg już nie ma, więc biblioteka wylicza hasQuotedMsg=false,
    // ale identyfikator cytowanej wiadomości nadal tam stoi.
    const message = fakeMessage({ data: { quotedStanzaID: 'ABCDEF' } });

    assert.equal(message.hasQuotedMsg, false);
    assert.equal(hasQuotedHint(message), true);
});

test('sam quotedParticipant też wystarcza za ślad odpowiedzi', () => {
    assert.equal(hasQuotedHint(fakeMessage({ data: { quotedParticipant: '5550100@c.us' } })), true);
    assert.equal(hasQuotedHint(fakeMessage({ data: { quotedRemoteJid: '5550100@c.us' } })), true);
});

test('puste pola nie udają odpowiedzi', () => {
    assert.equal(hasQuotedHint(fakeMessage({ data: { quotedStanzaID: '' } })), false);
    assert.equal(hasQuotedHint(fakeMessage({ data: { quotedStanzaID: null } })), false);
});

test('bez otwartej strony WhatsApp Weba odczyt cytatu zwraca pustkę, a nie wyjątek', async () => {
    const raw = await readQuotedFromStore(fakeMessage({ data: { quotedStanzaID: 'ABCDEF' } }));

    assert.equal(raw, null);
});

test('odpowiedź zapisuje się w archiwum razem z nadawcą i treścią cytatu', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir), fakeClient());

        await archive.save(
            fakeMessage({
                from: '5550100@c.us',
                body: 'zgadza się',
                quoted: { body: 'będziesz jutro?', contact: { name: 'Kontakt' } },
            }),
        );

        const [entry] = archive.pendingMessagesFor('5550100') ?? [];
        assert.deepEqual(entry?.quotedMsg, { sender: 'Kontakt', body: 'będziesz jutro?' });
    });
});

test('cytat z własnej wiadomości podpisuje się jako "Ja"', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir), fakeClient());

        await archive.save(
            fakeMessage({
                from: '5550100@c.us',
                body: 'no właśnie',
                quoted: { fromMe: true, body: 'jadę po ciebie' },
            }),
        );

        const [entry] = archive.pendingMessagesFor('5550100') ?? [];
        assert.equal(entry?.quotedMsg?.sender, 'Ja');
    });
});

test('cytowane zdjęcie bez podpisu dostaje w archiwum nazwę typu', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir), fakeClient());

        await archive.save(
            fakeMessage({
                from: '5550100@c.us',
                body: 'ładne',
                quoted: { type: 'image', body: '', fromMe: true },
            }),
        );

        const [entry] = archive.pendingMessagesFor('5550100') ?? [];
        assert.equal(entry?.quotedMsg?.body, '[zdjęcie]');
    });
});

test('wywrócone getQuotedMessage nie zabiera ze sobą całej wiadomości', async () => {
    await withTempDir(async (dir) => {
        const archive = new Archive(testConfig(dir), fakeClient());

        // Biblioteka rzuca zminifikowanym "r: r", a strony do odczytu
        // z kolekcji w tym teście nie ma - wiadomość i tak ma się zapisać.
        const saved = await archive.save(
            fakeMessage({ from: '5550100@c.us', body: 'no i co', quotedBroken: true }),
        );

        assert.equal(saved, true);
        const [entry] = archive.pendingMessagesFor('5550100') ?? [];
        assert.equal(entry?.body, 'no i co');
        assert.equal(entry?.quotedMsg, null);
    });
});
