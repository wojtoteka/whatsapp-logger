import test from 'node:test';
import assert from 'node:assert/strict';
import { isOneShot, normalizeCliArgs } from '../src/cli';

test('bezpośrednia flaga zostaje bez zmian i nie jest dublowana przez npm', () => {
    assert.deepEqual(
        normalizeCliArgs(['--sprawdz-archiwum'], { npm_config_sprawdz_archiwum: 'true' }),
        ['--sprawdz-archiwum'],
    );
});

test('flaga zamieniona przez npm na zmienną środowiskową wraca przed argument pozycyjny', () => {
    assert.deepEqual(normalizeCliArgs(['login-testowy'], { npm_config_uzytkownik: 'true' }), [
        '--uzytkownik',
        'login-testowy',
    ]);
});

test('tryby administracyjne są jednorazowe, zwykły start nie', () => {
    assert.equal(isOneShot(['--sprawdz']), true);
    assert.equal(isOneShot(['--sprawdz-archiwum']), true);
    assert.equal(isOneShot([]), false);
});
