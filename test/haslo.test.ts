import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, normalizeLogin, passwordProblem, verifyPassword } from '../src/haslo';

/**
 * Skrót wygenerowany tą właśnie implementacją, wpisany tu na stałe.
 *
 * Pilnuje rzeczy, której nie widać z poziomu jednego projektu: panel ma
 * własną kopię weryfikacji (panel/lib/haslo.ts), bo to osobna paczka npm.
 * Gdyby ktoś zmienił tu format albo parametry kosztu, logowanie do panelu
 * przestałoby działać, a nic by o tym nie krzyknęło - poza tym testem.
 */
const STALY_SKROT =
    'scrypt$16384$8$1$8afff4363b32cd4d9bc75edce8cc28dc$5fc1450be097403bc7272ccc1a06ea88deb0813d5479037fa40b4fec88936bb9';
const STALE_HASLO = 'tajne-haslo-testowe';

test('hasło zapisane wcześniej nadal się weryfikuje', async () => {
    assert.equal(await verifyPassword(STALE_HASLO, STALY_SKROT), true);
});

test('format skrótu się nie zmienił - panel czyta dokładnie taki', async () => {
    const skrot = await hashPassword('cokolwiek');
    const [algorytm, N, r, p, sol, wynik] = skrot.split('$');

    assert.equal(algorytm, 'scrypt');
    assert.equal(N, '16384');
    assert.equal(r, '8');
    assert.equal(p, '1');
    assert.match(sol ?? '', /^[0-9a-f]{32}$/);
    assert.match(wynik ?? '', /^[0-9a-f]{64}$/);
});

test('skrót mieści się w kolumnie bazy', async () => {
    // panel_users.password_hash to VARCHAR(255).
    const skrot = await hashPassword('x'.repeat(200));
    assert.ok(skrot.length <= 255, `skrót ma ${skrot.length} znaków`);
});

test('to samo hasło daje za każdym razem inny skrót', async () => {
    // Sól jest losowa, więc dwa konta z tym samym hasłem nie wyglądają
    // w bazie tak samo.
    const a = await hashPassword('powtarzalne');
    const b = await hashPassword('powtarzalne');

    assert.notEqual(a, b);
    assert.equal(await verifyPassword('powtarzalne', a), true);
    assert.equal(await verifyPassword('powtarzalne', b), true);
});

test('złe hasło nie przechodzi', async () => {
    const skrot = await hashPassword('prawidłowe');

    assert.equal(await verifyPassword('nieprawidłowe', skrot), false);
    assert.equal(await verifyPassword('', skrot), false);
    assert.equal(await verifyPassword('prawidłowe ', skrot), false, 'spacja na końcu to inne hasło');
});

test('polskie znaki i emoji działają w haśle', async () => {
    for (const haslo of ['ZażółćGęśląJaźń', 'hasło z emoji 🔐🙂', 'ŁÓDŹ-świerszcz']) {
        const skrot = await hashPassword(haslo);
        assert.equal(await verifyPassword(haslo, skrot), true, haslo);
    }
});

test('uszkodzony wpis w bazie nie wpuszcza nikogo', async () => {
    for (const zepsuty of [
        '',
        'bzdura',
        'scrypt$16384$8$1$tylko-cztery-czesci',
        'bcrypt$16384$8$1$aabb$ccdd',
        'scrypt$abc$8$1$aabb$ccdd',
        'scrypt$16384$8$1$$',
    ]) {
        assert.equal(await verifyPassword('cokolwiek', zepsuty), false, zepsuty);
    }
});

test('podmieniony choćby o bajt skrót przestaje pasować', async () => {
    const skrot = await hashPassword('prawidłowe');
    const podmieniony = skrot.slice(0, -2) + (skrot.endsWith('ff') ? '00' : 'ff');

    assert.equal(await verifyPassword('prawidłowe', podmieniony), false);
});

test('login sprowadzamy do jednej postaci', () => {
    assert.equal(normalizeLogin('  Uzytkownik '), 'uzytkownik');
    assert.equal(normalizeLogin('ADMIN'), 'admin');
});

test('za krótkie hasło jest odrzucane z powodem', () => {
    assert.match(passwordProblem('krotkie') ?? '', /8 znaków/);
    assert.match(passwordProblem('        ') ?? '', /spacjami/);
    assert.equal(passwordProblem('wystarczajaco-dlugie'), null);
});
