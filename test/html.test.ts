import test from 'node:test';
import assert from 'node:assert/strict';
import {
    batchFileName,
    esc,
    generateHtml,
    markDeletedInHtml,
    NEXT_LINK_MARKER,
    senderTone,
} from '../src/html';
import type { ArchivedMessage } from '../src/types';

function message(overrides: Partial<ArchivedMessage> = {}): ArchivedMessage {
    return {
        id: 'msg-1',
        timestamp: 1_700_000_000,
        from: 'Ala',
        fromMe: false,
        avatar: null,
        body: 'cześć',
        type: 'chat',
        mediaPath: null,
        mediaName: null,
        mediaSkipped: null,
        isDeleted: false,
        isForwarded: false,
        quotedMsg: null,
        location: null,
        contacts: null,
        poll: null,
        ...overrides,
    };
}

function render(messages: ArchivedMessage[], isLatest = true, batchNum = 1): string {
    return generateHtml({
        chatName: 'Ala',
        batchNum,
        messages,
        isLatest,
        messagesPerFile: 70,
        retentionNote: 'Starsze pliki kasują się po 180 dniach.',
    });
}

test('treść wiadomości jest escapowana, więc nie wstrzyknie się jako znacznik', () => {
    const html = render([message({ body: '<script>alert(1)</script>' })]);

    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
});

test('nazwa czatu też przechodzi przez escapowanie', () => {
    const html = generateHtml({
        chatName: '<img onerror=x>',
        batchNum: 1,
        messages: [message()],
        isLatest: true,
        messagesPerFile: 70,
        retentionNote: '',
    });

    assert.ok(!html.includes('<img onerror=x>'));
    assert.ok(html.includes('&lt;img onerror=x&gt;'));
});

test('adres w treści staje się odnośnikiem, a kropka na końcu zdania w nim nie ląduje', () => {
    const html = render([message({ body: 'zobacz https://example.com/a.' })]);

    assert.ok(html.includes('href="https://example.com/a"'));
    assert.ok(html.includes('>https://example.com/a</a>.'));
});

test('nowa partia jest najnowsza, więc odnośnik "dalej" jest wyszarzony', () => {
    const html = render([message()], true);

    assert.ok(html.includes(NEXT_LINK_MARKER.open));
    assert.ok(html.includes('Dalszych części jeszcze nie ma'));
    assert.ok(html.includes('To pierwsza część'));
});

test('część ze znanym następnikiem dostaje działający odnośnik i odnośnik wstecz', () => {
    const html = render([message()], false, 2);

    assert.ok(html.includes(`href="${batchFileName(3)}"`));
    assert.ok(html.includes(`href="${batchFileName(1)}"`));
});

test('każda wiadomość niesie swój identyfikator, po którym da się ją potem odnaleźć', () => {
    const html = render([message({ id: 'ABC_123' })]);

    assert.ok(html.includes('data-id="ABC_123"'));
});

test('wiadomość skasowaną można oznaczyć w gotowym już pliku', () => {
    const html = render([message({ id: 'do-skasowania' }), message({ id: 'zostaje' })]);
    assert.ok(!html.includes('Skasowana w WhatsAppie'));

    const patched = markDeletedInHtml(html, 'do-skasowania');
    assert.ok(patched !== null);
    assert.ok(patched.includes('Skasowana w WhatsAppie'));
    assert.equal(countOccurrences(patched, 'Skasowana w WhatsAppie'), 1);
    assert.ok(patched.includes('was-deleted'));
});

test('powtórne oznaczenie tej samej wiadomości nic już nie zmienia', () => {
    const html = render([message({ id: 'x' })]);
    const once = markDeletedInHtml(html, 'x');
    assert.ok(once !== null);

    assert.equal(markDeletedInHtml(once, 'x'), null, 'druga próba nie ma nic do roboty');
});

test('oznaczanie wiadomości, której w pliku nie ma, zwraca null', () => {
    const html = render([message({ id: 'a' })]);

    assert.equal(markDeletedInHtml(html, 'b'), null);
});

test('wiadomość zapisana jako skasowana od razu ma notkę w pliku', () => {
    const html = render([message({ isDeleted: true })]);

    assert.ok(html.includes('Skasowana w WhatsAppie'));
});

test('plik z mediami pokazuje zdjęcie, a pominięty plik zostawia notatkę', () => {
    const withImage = render([message({ mediaPath: 'media/foto.jpg', type: 'image' })]);
    assert.ok(withImage.includes('src="media/foto.jpg"'));

    const skipped = render([
        message({
            mediaSkipped: { reason: 'plik ponad limit 100 MB', type: 'video', filename: 'f.mp4', bytes: 200 * 1024 * 1024 },
        }),
    ]);
    assert.ok(skipped.includes('Nie zapisano pliku'));
    assert.ok(skipped.includes('plik ponad limit 100 MB'));
    assert.ok(skipped.includes('200.0 MB'));
});

test('lokalizacja, wizytówka i ankieta rozkładają się na czytelne części', () => {
    const html = render([
        message({ type: 'location', location: { latitude: 52.1, longitude: 21.2, name: 'Dom', address: null } }),
        message({ id: 'm2', type: 'vcard', contacts: [{ name: 'Ola', numbers: ['+48 111 222 333'], org: null }] }),
        message({ id: 'm3', type: 'poll_creation', poll: { question: 'Kiedy?', options: ['dziś', 'jutro'], multiple: true } }),
    ]);

    assert.ok(html.includes('openstreetmap.org'));
    assert.ok(html.includes('Dom'));
    assert.ok(html.includes('Ola'));
    assert.ok(html.includes('tel:+48111222333'));
    assert.ok(html.includes('Kiedy?'));
    assert.ok(html.includes('Można wybrać kilka odpowiedzi.'));
});

test('ten sam nadawca zawsze dostaje ten sam kolor imienia', () => {
    assert.equal(senderTone('Ala'), senderTone('Ala'));
    assert.match(senderTone('Ala'), /^n[1-6]$/);
    assert.match(senderTone(''), /^n[1-6]$/);
});

test('escapowanie ogarnia wszystkie znaki, które psułyby stronę', () => {
    assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#039;');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
});

test('pusta partia daje poprawny plik, a nie pustą stronę', () => {
    const html = render([]);

    assert.ok(html.includes('Ta część nie zawiera wiadomości.'));
    assert.ok(html.trimStart().startsWith('<!DOCTYPE html>'));
});

function countOccurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}
