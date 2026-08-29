import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, toArchivePath, toMessageRow } from '../src/db';
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

test('ścieżka mediów zwykłego czatu liczy się od folderu archiwum', () => {
    assert.equal(toArchivePath('Ala', 'media/foto.png'), 'Ala/media/foto.png');
});

test('ukośniki Windowsa zamieniają się na te, które rozumie przeglądarka', () => {
    // path.relative na Windowsie zwraca "media\\foto.png".
    assert.equal(toArchivePath('Ala', 'media\\foto.png'), 'Ala/media/foto.png');
});

test('zdjęcie profilowe zwykłego czatu trafia do wspólnego _avatars', () => {
    // Na dysku zapisujemy je względem folderu czatu, bo tak działa HTML.
    assert.equal(toArchivePath('Ala', '../_avatars/48111@c.us/2026-08-20.jpg'), '_avatars/48111@c.us/2026-08-20.jpg');
});

test('relacje leżą o poziom głębiej, a ścieżka i tak wychodzi poprawnie', () => {
    // Statusy/<autor> to dwa poziomy, więc odnośnik ma dwa razy "..".
    assert.equal(
        toArchivePath('Statusy/Dawid', '../../_avatars/48697@c.us/2026-08-29.jpg'),
        '_avatars/48697@c.us/2026-08-29.jpg',
    );
    assert.equal(toArchivePath('Statusy/Dawid', 'media/storka.png'), 'Statusy/Dawid/media/storka.png');
});

test('ścieżka wychodząca poza archiwum nie ma prawa trafić do bazy', () => {
    // Inaczej panel serwowałby pliki spoza folderu z logami.
    assert.equal(toArchivePath('Ala', '../../../etc/passwd'), null);
    assert.equal(toArchivePath('Ala', '../../sekret.txt'), null);
});

test('brak ścieżki zostaje brakiem, a nie pustym napisem', () => {
    assert.equal(toArchivePath('Ala', null), null);
});

test('wiadomość zamienia się w wiersz z rozwiązanymi ścieżkami', () => {
    const row = toMessageRow(
        message({
            mediaPath: 'media/foto.png',
            mediaName: 'wakacje.png',
            avatar: '../_avatars/ala/2026-08-20.jpg',
            type: 'image',
            body: 'popatrz',
        }),
        '48111222333@c.us',
        'Ala',
    );

    assert.equal(row.chatId, '48111222333@c.us');
    assert.equal(row.mediaPath, 'Ala/media/foto.png');
    assert.equal(row.avatarPath, '_avatars/ala/2026-08-20.jpg');
    assert.equal(row.body, 'popatrz');
    assert.equal(row.ts, 1_700_000_000);
    assert.equal(row.fromMe, false);
});

test('pola złożone jadą do bazy jako JSON, a puste jako brak', () => {
    const row = toMessageRow(
        message({
            location: { latitude: 52.1, longitude: 21.2, name: 'Dom', address: null },
            poll: { question: 'Kiedy?', options: ['dziś'], multiple: false },
        }),
        'czat',
        'Ala',
    );

    assert.deepEqual(JSON.parse(row.location ?? 'null'), {
        latitude: 52.1,
        longitude: 21.2,
        name: 'Dom',
        address: null,
    });
    assert.equal(JSON.parse(row.poll ?? 'null').question, 'Kiedy?');
    assert.equal(row.contacts, null);
    assert.equal(row.quoted, null);
    assert.equal(row.mediaSkipped, null);
});

test('zbyt długa nazwa nadawcy jest przycinana do rozmiaru kolumny', () => {
    const row = toMessageRow(message({ from: 'x'.repeat(400) }), 'czat', 'Ala');

    assert.equal(row.sender.length, 255);
});

test('schemat zakłada tabele tylko wtedy, gdy ich nie ma', () => {
    // Dzięki temu można go puszczać przy każdym starcie programu.
    assert.equal(SCHEMA.length, 3, 'czaty, wiadomości i konta do panelu');
    for (const statement of SCHEMA) {
        assert.match(statement, /CREATE TABLE IF NOT EXISTS/);
        // utf8mb4 jest obowiązkowe - bez niego emoji wywracają zapis.
        assert.match(statement, /utf8mb4/);
    }
});

test('konta do panelu mają unikalny login', () => {
    const users = SCHEMA[2] ?? '';

    assert.match(users, /CREATE TABLE IF NOT EXISTS panel_users/);
    assert.match(users, /UNIQUE KEY uq_panel_users_login \(login\)/, 'dwa konta o tym samym loginie nie mają prawa powstać');
    // Skrót scrypt ma 114 znaków - kolumna musi go pomieścić z zapasem.
    assert.match(users, /password_hash VARCHAR\(255\)/);
});

test('tabela wiadomości ma indeksy, na których stoi panel', () => {
    const messages = SCHEMA[1] ?? '';

    assert.match(messages, /KEY idx_messages_chat \(chat_id, ts DESC\)/, 'rozmowa od najnowszych');
    assert.match(messages, /KEY idx_messages_ts \(ts DESC\)/, 'wszystko od najnowszych');
    assert.match(messages, /FULLTEXT KEY ft_messages_body/, 'wyszukiwanie w treści');
});
