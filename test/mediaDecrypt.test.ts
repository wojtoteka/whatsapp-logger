import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    candidateUrls,
    decryptMedia,
    downloadAndDecrypt,
    encryptMedia,
    hkdfInfoFor,
    type FetchLike,
    type MediaKeys,
} from '../src/mediaDecrypt';

const KEY = crypto.randomBytes(32).toString('base64');

function keys(overrides: Partial<MediaKeys> = {}): MediaKeys {
    return {
        directPath: '/v/t62.7118-24/plik.enc?ccb=11-4&oh=abc&oe=def',
        url: null,
        mediaKey: KEY,
        type: 'image',
        mimetype: 'image/jpeg',
        filename: null,
        size: null,
        encFilehash: null,
        ...overrides,
    };
}

function serving(body: Buffer, seen: string[] = [], status = 200): FetchLike {
    return async (url) => {
        seen.push(url);
        return {
            ok: status >= 200 && status < 300,
            status,
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) as ArrayBuffer,
        };
    };
}

test('odszyfrowanie odwraca szyfrowanie dla każdego rodzaju mediów', () => {
    const plain = crypto.randomBytes(1000);
    for (const type of ['image', 'video', 'ptt', 'document', 'sticker']) {
        const info = hkdfInfoFor(type, null);
        assert.deepEqual(decryptMedia(encryptMedia(plain, KEY, info), KEY, info), plain);
    }
});

test('rodzaj mediów wybiera właściwe info do HKDF', () => {
    assert.equal(hkdfInfoFor('image', null), 'WhatsApp Image Keys');
    assert.equal(hkdfInfoFor('sticker', null), 'WhatsApp Image Keys');
    assert.equal(hkdfInfoFor('ptt', null), 'WhatsApp Audio Keys');
    assert.equal(hkdfInfoFor('video', null), 'WhatsApp Video Keys');
    assert.equal(hkdfInfoFor('document', 'application/pdf'), 'WhatsApp Document Keys');
    assert.equal(hkdfInfoFor(null, 'image/png'), 'WhatsApp Image Keys');
});

test('uszkodzony plik nie przechodzi weryfikacji podpisu', () => {
    const info = hkdfInfoFor('image', null);
    const encrypted = encryptMedia(Buffer.from('zdjęcie'), KEY, info);
    encrypted[0] = (encrypted[0] ?? 0) ^ 0xff;
    assert.throws(() => decryptMedia(encrypted, KEY, info), /podpis/);
});

test('plik schodzi z mmg.whatsapp.net i wraca jako base64', async () => {
    const plain = Buffer.from('to jest zdjęcie');
    const encrypted = encryptMedia(plain, KEY, 'WhatsApp Image Keys');
    const seen: string[] = [];

    const media = await downloadAndDecrypt(
        keys({ encFilehash: crypto.createHash('sha256').update(encrypted).digest('base64') }),
        serving(encrypted, seen),
    );

    assert.deepEqual(seen, ['https://mmg.whatsapp.net/v/t62.7118-24/plik.enc?ccb=11-4&oh=abc&oe=def']);
    assert.equal(Buffer.from(media.data, 'base64').toString(), 'to jest zdjęcie');
    assert.equal(media.mimetype, 'image/jpeg');
});

test('odmowa serwera mediów jest nazwana kodem odpowiedzi', async () => {
    await assert.rejects(downloadAndDecrypt(keys(), serving(Buffer.alloc(0), [], 404)), /404/);
});

test('adresy spoza serwerów WhatsAppa są pomijane', () => {
    assert.deepEqual(candidateUrls(keys({ directPath: null, url: 'https://example.com/plik' })), []);
    assert.deepEqual(candidateUrls(keys({ directPath: 'bez-ukośnika', url: null })), []);
    assert.deepEqual(
        candidateUrls(keys({ directPath: null, url: 'https://media-waw1-1.cdn.whatsapp.net/v/plik' })),
        ['https://media-waw1-1.cdn.whatsapp.net/v/plik'],
    );
});
