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
            lidToPhone: { '999@lid': '5550100@c.us' },
            contacts: {
                '5550100@c.us': { id: { _serialized: '5550100@c.us' }, number: '5550100', name: 'Kontakt z pracy', isMyContact: true },
            },
        }),
    );

    const identity = await resolver.resolve(fakeMessage({ from: '999@lid' }), '999@lid');

    assert.equal(identity?.name, 'Kontakt z pracy');
    assert.equal(identity?.tier, NameTier.SAVED);
    assert.equal(identity?.id, '5550100@c.us', 'archiwum prowadzimy pod numerem, nie pod @lid');
});

test('niezapisany kontakt dostaje swoją nazwę profilu, a nie numer', async () => {
    const resolver = new IdentityResolver(
        fakeClient({
            lidToPhone: { '999@lid': '5550100@c.us' },
            contacts: {
                '5550100@c.us': { id: { _serialized: '5550100@c.us' }, number: '5550100', pushname: 'Nazwa profilu' },
            },
        }),
    );

    const identity = await resolver.resolve(fakeMessage({ from: '999@lid' }), '999@lid');

    assert.equal(identity?.name, 'Nazwa profilu');
    assert.equal(identity?.tier, NameTier.NICK);
});

test('bez nazwy zostaje numer telefonu, a folder i tak nie nazywa się cyframi @lid', async () => {
    const resolver = new IdentityResolver(
        fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' }, contacts: {} }),
    );

    const identity = await resolver.resolve(fakeMessage({ from: '999@lid' }), '999@lid');

    assert.equal(identity?.name, '5550100');
    assert.equal(identity?.tier, NameTier.NUMBER);
    assert.equal(identity?.id, '5550100@c.us');
});

test('gdy WhatsApp nie zna numeru, nazwa profilu z wiadomości ratuje folder przed cyframi', async () => {
    const resolver = new IdentityResolver(fakeClient({ lidToPhone: {}, contacts: {} }));

    const identity = await resolver.resolve(
        fakeMessage({ from: '999@lid', notifyName: 'Profil testowy' }),
        '999@lid',
    );

    assert.equal(identity?.name, 'Profil testowy');
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
        fakeMessage({ from: '777000@g.us', chatName: 'Grupa testowa' }),
        '777000@g.us',
    );

    assert.equal(identity?.name, 'Grupa testowa');
    assert.equal(identity?.tier, NameTier.SAVED);
    assert.equal(identity?.id, '777000@g.us');
});

test('grupa bez odpowiedzi z getChat nie wywraca rozpoznawania', async () => {
    const resolver = new IdentityResolver(fakeClient());

    const identity = await resolver.resolve(
        fakeMessage({ from: '777000@g.us', chatName: null }),
        '777000@g.us',
    );

    assert.equal(identity?.id, '777000@g.us');
    assert.equal(identity?.tier, NameTier.ID);
});

test('numer @lid pytamy tylko raz - wynik zostaje w pamięci', async () => {
    let calls = 0;
    const client = fakeClient({ lidToPhone: { '999@lid': '5550100@c.us' } });
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

test('mapowanie @lid zachowuje systemowe konto WhatsAppa do późniejszego odfiltrowania', async () => {
    for (const phone of ['0', '0@c.us', '0@s.whatsapp.net']) {
        const resolver = new IdentityResolver(
            fakeClient({ lidToPhone: { '999@lid': phone }, contacts: {} }),
        );

        assert.equal(await resolver.phoneForLid('999@lid'), '0');
        assert.equal(await resolver.phoneForLid('999@lid'), '0', 'także wynik z pamięci zachowuje 0');
        const identity = await resolver.resolve(null, '999@lid');
        assert.equal(identity?.id, '0@c.us');
    }
});

test('kontakt zachowuje systemowe 0 z numeru lub identyfikatora, ale nie dowolny krótki numer', () => {
    for (const systemId of ['0', '0@c.us', '0@s.whatsapp.net']) {
        const byNumber = readContact({ number: systemId } as unknown as WaContact, '999@lid');
        const byId = readContact({ id: { _serialized: systemId } } as unknown as WaContact, '999@lid');

        assert.equal(byNumber.number, '0');
        assert.equal(byId.number, '0');
    }
    for (const invalid of ['1', '00', '12345', '0@newsletter', '0@g.us']) {
        const info = readContact({ number: invalid } as unknown as WaContact, '999@lid');
        assert.equal(info.number, null, invalid);
    }
});

test('cyfry z @lid nigdy nie zostają podane jako numer telefonu', () => {
    // WhatsApp wkłada w takie pola sam identyfikator, gdy numeru nie zna.
    const contact = {
        id: { _serialized: '5550199@lid' },
        number: '5550199',
        pushname: 'Profil',
    } as unknown as WaContact;

    const info = readContact(contact, '5550199@lid');

    assert.equal(info.number, null);
    assert.equal(info.nick, 'Profil');
});

test('skrócona nazwa liczy się jako zapisany kontakt tylko dla kogoś z książki', () => {
    const saved = readContact(
        { shortName: 'Kontakt', isMyContact: true } as unknown as WaContact,
        '5550100@c.us',
    );
    assert.equal(saved.saved, 'Kontakt');

    const stranger = readContact(
        { shortName: '+555 010', isMyContact: false, pushname: 'Kontakt' } as unknown as WaContact,
        '5550100@c.us',
    );
    assert.equal(stranger.saved, null);
    assert.equal(stranger.nick, 'Kontakt');
});

test('nazwa profilu nie jest brana z własnych wiadomości ani z grup', () => {
    assert.equal(pushNameOf(fakeMessage({ notifyName: 'Kontakt' }), '999@lid'), 'Kontakt');
    assert.equal(pushNameOf(fakeMessage({ notifyName: 'Kontakt', fromMe: true }), '999@lid'), null);
    assert.equal(pushNameOf(fakeMessage({ notifyName: 'Kontakt' }), '120363@g.us'), null);
});

test('identyfikator czatu bierzemy z właściwej strony wiadomości', () => {
    assert.equal(chatIdOf(fakeMessage({ from: 'a@c.us', to: 'me@c.us' })), 'a@c.us');
    assert.equal(chatIdOf(fakeMessage({ from: 'me@c.us', to: 'b@c.us', fromMe: true })), 'b@c.us');
    assert.equal(chatIdOf(null), null);
});

test('nazwa zastępcza to same cyfry z identyfikatora', () => {
    assert.equal(placeholderName('5550199@lid'), '5550199');
    assert.equal(placeholderName('5550100@c.us'), '5550100');
});

test('nazwa nadawcy do wyświetlenia idzie od najlepszej do najgorszej', () => {
    assert.equal(
        contactDisplayName({ name: 'Kontakt', pushname: 'profil123', number: '48111' } as unknown as WaContact),
        'Kontakt',
    );
    assert.equal(
        contactDisplayName({ pushname: 'profil123', number: '48111' } as unknown as WaContact),
        'profil123',
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

test('model revoked bez before wskazuje oryginalne ID przez protocolMessageKey', () => {
    const message = fakeMessage({ id: 'techniczny', type: 'revoked' });
    (message as unknown as { protocolMessageKey: unknown }).protocolMessageKey = {
        _serialized: 'oryginalna-wiadomosc',
    };
    assert.equal(messageKey(message), 'oryginalna-wiadomosc');
});
