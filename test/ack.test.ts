// Potwierdzenia doręczenia: kiedy odbiorca dostał wiadomość i kiedy ją odczytał.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ACK, ackOf, applyAck, isDelivered, isRead } from '../src/ack';
import { generateHtml, markAckInHtml } from '../src/html';
import type { ArchivedMessage } from '../src/types';
import { fakeMessage } from './helpers';

function own(overrides: Partial<ArchivedMessage> = {}): ArchivedMessage {
    return {
        id: 'moja-1',
        timestamp: 1_700_000_000,
        from: 'Ja',
        fromMe: true,
        avatar: null,
        body: 'jesteś?',
        type: 'chat',
        mediaPath: null,
        mediaName: null,
        mediaSkipped: null,
        isDeleted: false,
        deletedAt: null,
        ack: null,
        deliveredAt: null,
        readAt: null,
        isForwarded: false,
        quotedMsg: null,
        location: null,
        contacts: null,
        poll: null,
        ...overrides,
    };
}

test('odczytanie zapisuje stan i godzinę, w której je zobaczyliśmy', () => {
    const message = own();

    assert.equal(applyAck(message, ACK.DEVICE, '2026-08-31T18:00:00.000Z'), true);
    assert.equal(message.deliveredAt, '2026-08-31T18:00:00.000Z');
    assert.equal(message.readAt, null, 'dostarczona to jeszcze nie przeczytana');

    assert.equal(applyAck(message, ACK.READ, '2026-08-31T19:30:00.000Z'), true);
    assert.equal(message.ack, ACK.READ);
    assert.equal(message.readAt, '2026-08-31T19:30:00.000Z');
    assert.equal(
        message.deliveredAt,
        '2026-08-31T18:00:00.000Z',
        'godzina doręczenia zostaje ta pierwsza',
    );
});

test('ten sam stan drugi raz niczego nie zmienia - i nie każe zapisywać plików', () => {
    const message = own({ ack: ACK.READ, readAt: '2026-08-31T19:30:00.000Z' });

    assert.equal(applyAck(message, ACK.READ, '2026-08-31T20:00:00.000Z'), false);
    assert.equal(message.readAt, '2026-08-31T19:30:00.000Z');
});

test('stan nigdy się nie cofa, choć WhatsApp potrafi go zgłosić od nowa', () => {
    // Po ponownym połączeniu z telefonem model wiadomości bywa liczony
    // od zera. "Przeczytana" nie ma prawa przez to zniknąć z archiwum.
    const message = own({ ack: ACK.READ, readAt: '2026-08-31T19:30:00.000Z' });

    assert.equal(applyAck(message, ACK.SERVER, '2026-09-01T08:00:00.000Z'), false);
    assert.equal(message.ack, ACK.READ);
    assert.equal(message.readAt, '2026-08-31T19:30:00.000Z');
});

test('stan poznany po fakcie zapisuje się bez zmyślania godziny odczytu', () => {
    // Tak wygląda wiadomość odczytana wtedy, gdy program nie pracował:
    // wiadomo, że przeczytana, nie wiadomo kiedy.
    const message = own();

    assert.equal(applyAck(message, ACK.READ, null), true);
    assert.equal(message.ack, ACK.READ);
    assert.equal(message.readAt, null);
    assert.equal(message.deliveredAt, null);
});

test('brak stanu z WhatsAppa nie jest zmianą', () => {
    const message = own({ ack: ACK.SERVER });

    assert.equal(applyAck(message, null, '2026-08-31T19:30:00.000Z'), false);
    assert.equal(message.ack, ACK.SERVER);
});

test('stan czytamy wprost z wiadomości WhatsAppa', () => {
    assert.equal(ackOf(fakeMessage({ fromMe: true, ack: ACK.READ })), ACK.READ);
    assert.equal(ackOf(fakeMessage({ fromMe: true })), null, 'brak pola to brak wiedzy');
    assert.equal(ackOf(null), null);

    assert.equal(isDelivered(ACK.DEVICE), true);
    assert.equal(isDelivered(ACK.SERVER), false);
    assert.equal(isRead(ACK.PLAYED), true, 'odsłuchana jest też przeczytana');
    assert.equal(isRead(ACK.DEVICE), false);
});

// ── Zapis w pliku HTML ───────────────────────────────────────────────────

function html(messages: ArchivedMessage[]): string {
    return generateHtml({
        chatName: 'Kontakt',
        batchNum: 1,
        messages,
        isLatest: true,
        messagesPerFile: 100,
        retentionNote: '',
    });
}

test('przeczytana wiadomość pokazuje w archiwum godzinę odczytu', () => {
    const page = html([own({ ack: ACK.READ, readAt: '2026-08-31T19:30:00.000Z' })]);

    assert.match(page, /Przeczytana/);
    assert.match(page, /i-ticks/, 'dwa ptaszki, nie jeden');
});

test('przeczytana bez znanej godziny mówi o tym wprost w podpowiedzi', () => {
    const page = html([own({ ack: ACK.READ, readAt: null })]);

    assert.match(page, /Przeczytana/);
    assert.match(page, /nie podał godziny/);
});

test('cudza wiadomość nie dostaje znacznika doręczenia', () => {
    const page = html([own({ fromMe: false, from: 'Kontakt', ack: ACK.READ })]);

    assert.doesNotMatch(page, /Przeczytana/);
    assert.doesNotMatch(page, /<!--ack-->/, 'kotwicy też nie ma po co trzymać');
});

test('doręczenie dopisuje się do gotowego pliku, a potem ustępuje odczytaniu', () => {
    const page = html([own()]);
    assert.doesNotMatch(page, /Dostarczona/);

    const delivered = own({ ack: ACK.DEVICE, deliveredAt: '2026-08-31T18:00:00.000Z' });
    const afterDelivery = markAckInHtml(page, 'moja-1', delivered);
    assert.ok(afterDelivery);
    assert.match(afterDelivery, /Dostarczona/);

    const read = own({
        ack: ACK.READ,
        deliveredAt: '2026-08-31T18:00:00.000Z',
        readAt: '2026-08-31T19:30:00.000Z',
    });
    const afterRead = markAckInHtml(afterDelivery, 'moja-1', read);
    assert.ok(afterRead, 'kotwicę wymieniamy wielokrotnie, nie tylko raz');
    assert.match(afterRead, /Przeczytana/);
    assert.doesNotMatch(afterRead, /Dostarczona/, 'stary znacznik ma zniknąć, a nie się dokleić');
});

test('ten sam znacznik drugi raz nie każe przepisywać pliku', () => {
    const read = own({ ack: ACK.READ, readAt: '2026-08-31T19:30:00.000Z' });
    const page = html([read]);

    assert.equal(markAckInHtml(page, 'moja-1', read), null);
    assert.equal(markAckInHtml(page, 'kogoś-innego', read), null);
});

test('plik sprzed tej wersji programu zostaje nietknięty', () => {
    // Bąbelki bez kotwicy: gdyby szukanie szło dalej, trafiłoby w cudzą.
    const stary = '<article class="msg own" data-id="moja-1"><div class="bubble">a</div></article>';

    assert.equal(markAckInHtml(stary, 'moja-1', own({ ack: ACK.READ })), null);
});
