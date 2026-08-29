import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chatIdOf,
    contactDisplayName,
    IdentityResolver,
    messageHash,
    messageKey,
    placeholderName,
    pushNameOf,
    readContact,
} from '../src/identity';
import { NameTier } from '../src/types';
import type { WaContact } from '../src/types';
import { fakeClient, fakeMessage } from './helpers';

test('zapisany kontakt daje nazwę z książki adresowej i najwyższy poziom pewności', async () => {
    const resolver = new IdentityResolver(
        fakeClient({
            lidToPhone: { '999@lid': '48111222333@c.us' },
            contacts: {
                '48111222333@c.us': { id: { _serialized: '48111222333@c.us' }, number: '48111222333', name: 'Ala z pracy', isMyContact: true },
            },
        }),
    );

    const identity = await resolver.resolve(fakeMessage({ from: '999@lid' }), '999@lid');

    assert.equal(identity?.name, 'Ala z pracy');
    assert.equal(identity?.tier, NameTier.SAVED);
    assert.equal(identity?.id, '48111222333@c.us', 'archiwum prowadzimy pod numerem, nie pod @lid');
});

test('niezapisany kontakt dostaje swoją nazwę profilu, a nie numer', async () => {
    const resolver = new IdentityResolver(
        fakeClient({
            lidToPhone: { '999@lid': '48111222333@c.us' },
            contacts: {
                '48111222333@c.us': { id: { _serialized: '48111222333@c.us' }, number: '48111222333', pushname: 'Nazwa profilu' },
            },
        }),
    );

    const identity = await resolver.resolve(fakeMessage({ from: '999@lid' }), '999@lid');

    assert.equal(identity?.name, 'Nazwa profilu');
    assert.equal(identity?.tier, NameTier.NICK);
});

test('bez nazwy zostaje numer telefonu, a folder i tak nie nazywa się cyframi @lid', async () => {
    const resolver = new IdentityResolver(
        fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' }, contacts: {} }),
    );

    const identity = await resolver.resolve(fakeMessage({ from: '999@lid' }), '999@lid');

    assert.equal(identity?.name, '48111222333');
    assert.equal(identity?.tier, NameTier.NUMBER);
    assert.equal(identity?.id, '48111222333@c.us');
});

test('gdy WhatsApp nie zna numeru, nazwa profilu z wiadomości ratuje folder przed cyframi', async () => {
    const resolver = new IdentityResolver(fakeClient({ lidToPhone: {}, contacts: {} }));

    const identity = await resolver.resolve(
        fakeMessage({ from: '999@lid', notifyName: 'Krzysiek' }),
        '999@lid',
    );

    assert.equal(identity?.name, 'Krzysiek');
    assert.equal(identity?.tier, NameTier.NICK);
    assert.equal(identity?.id, '999@lid', 'numeru nie ma, więc zostaje identyfikator z wiadomości');
});

test('gdy nie ma zupełnie nic, nazwą są cyfry z identyfikatora', async () => {
    const resolver = new IdentityResolver(fakeClient({ lidToPhone: {}, contacts: {} }));

    const identity = await resolver.resolve(fakeMessage({ from: '999@lid' }), '999@lid');

    assert.equal(identity?.name, '999');
    assert.equal(identity?.tier, NameTier.ID);
});

test('grupa bierze nazwę wprost z getChat i nie zmienia identyfikatora', async () => {
    const resolver = new IdentityResolver(fakeClient());

    const identity = await resolver.resolve(
        fakeMessage({ from: '120363000@g.us', chatName: 'Ekipa wyjazdowa' }),
        '120363000@g.us',
    );

    assert.equal(identity?.name, 'Ekipa wyjazdowa');
    assert.equal(identity?.tier, NameTier.SAVED);
    assert.equal(identity?.id, '120363000@g.us');
});

test('grupa bez odpowiedzi z getChat nie wywraca rozpoznawania', async () => {
    const resolver = new IdentityResolver(fakeClient());

    const identity = await resolver.resolve(
        fakeMessage({ from: '120363000@g.us', chatName: null }),
        '120363000@g.us',
    );

    assert.equal(identity?.id, '120363000@g.us');
    assert.equal(identity?.tier, NameTier.ID);
});

test('numer @lid pytamy tylko raz - wynik zostaje w pamięci', async () => {
    let calls = 0;
    const client = fakeClient({ lidToPhone: { '999@lid': '48111222333@c.us' } });
    const original = client.getContactLidAndPhone.bind(client);
    client.getContactLidAndPhone = async (ids: string[]) => {
        calls++;
        return original(ids);
    };

    const resolver = new IdentityResolver(client);
    await resolver.phoneForLid('999@lid');
    await resolver.phoneForLid('999@lid');

    assert.equal(calls, 1);
});

test('cyfry z @lid nigdy nie zostają podane jako numer telefonu', () => {
    // WhatsApp wkłada w takie pola sam identyfikator, gdy numeru nie zna.
    const contact = {
        id: { _serialized: '252402947067958@lid' },
        number: '252402947067958',
        pushname: 'Ktoś',
    } as unknown as WaContact;

    const info = readContact(contact, '252402947067958@lid');

    assert.equal(info.number, null);
    assert.equal(info.nick, 'Ktoś');
});

test('skrócona nazwa liczy się jako zapisany kontakt tylko dla kogoś z książki', () => {
    const saved = readContact(
        { shortName: 'Ola', isMyContact: true } as unknown as WaContact,
        '48111222333@c.us',
    );
    assert.equal(saved.saved, 'Ola');

    const stranger = readContact(
        { shortName: '+48 111', isMyContact: false, pushname: 'Ola' } as unknown as WaContact,
        '48111222333@c.us',
    );
    assert.equal(stranger.saved, null);
    assert.equal(stranger.nick, 'Ola');
});

test('nazwa profilu nie jest brana z własnych wiadomości ani z grup', () => {
    assert.equal(pushNameOf(fakeMessage({ notifyName: 'Ala' }), '999@lid'), 'Ala');
    assert.equal(pushNameOf(fakeMessage({ notifyName: 'Ala', fromMe: true }), '999@lid'), null);
    assert.equal(pushNameOf(fakeMessage({ notifyName: 'Ala' }), '120363@g.us'), null);
});

test('identyfikator czatu bierzemy z właściwej strony wiadomości', () => {
    assert.equal(chatIdOf(fakeMessage({ from: 'a@c.us', to: 'me@c.us' })), 'a@c.us');
    assert.equal(chatIdOf(fakeMessage({ from: 'me@c.us', to: 'b@c.us', fromMe: true })), 'b@c.us');
    assert.equal(chatIdOf(null), null);
});

test('nazwa zastępcza to same cyfry z identyfikatora', () => {
    assert.equal(placeholderName('252402947067958@lid'), '252402947067958');
    assert.equal(placeholderName('48111222333@c.us'), '48111222333');
});

test('nazwa nadawcy do wyświetlenia idzie od najlepszej do najgorszej', () => {
    assert.equal(
        contactDisplayName({ name: 'Ala', pushname: 'ala123', number: '48111' } as unknown as WaContact),
        'Ala',
    );
    assert.equal(
        contactDisplayName({ pushname: 'ala123', number: '48111' } as unknown as WaContact),
        'ala123',
    );
    assert.equal(contactDisplayName({ number: '48111' } as unknown as WaContact), '48111');
    assert.equal(contactDisplayName(null), null);
});

test('gotowe id._serialized bierzemy wprost', () => {
    assert.equal(messageKey(fakeMessage({ id: 'true_48111@c.us_ABC' })), 'true_48111@c.us_ABC');
});

test('relacja bez _serialized dostaje klucz złożony z części identyfikatora', () => {
    // Tak wyglądają wiadomości z getBroadcasts(): biblioteka buduje je
    // z surowego serialize(), gdzie tego pola po prostu nie ma.
    const message = fakeMessage({ id: 'HASH123', from: '999@lid', rawStatusId: true });

    assert.equal(messageKey(message), 'false_status@broadcast_HASH123_999@lid');
    assert.equal(messageHash(message), 'HASH123');
});

test('klucz jest ten sam przy każdym odczycie tej samej relacji', () => {
    const first = fakeMessage({ id: 'HASH123', from: '999@lid', rawStatusId: true });
    const second = fakeMessage({ id: 'HASH123', from: '999@lid', rawStatusId: true });

    assert.equal(messageKey(first), messageKey(second));
});

test('brak identyfikatora daje null, a nie wymyśloną wartość', () => {
    assert.equal(messageKey(null), null);
    assert.equal(messageKey({ id: {} } as never), null);
    assert.equal(messageHash(null), null);
});
