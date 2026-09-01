import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decideLoggerRestart,
    EXIT_AUTH_FAILURE,
    EXIT_QR_UNSCANNED,
    RESTART_MAX_ATTEMPTS,
    RESTART_WINDOW_MS,
    shouldRelinkWithoutRestart,
} from '../src/restart';

test('kolejne awarie dostają rosnące opóźnienie z limitem jednej minuty', () => {
    const now = 1_000_000;

    assert.equal(decideLoggerRestart(1, [], now).delayMs, 5000);
    assert.equal(decideLoggerRestart(1, [now - 1], now).delayMs, 10_000);
    assert.equal(decideLoggerRestart(1, new Array(7).fill(now - 1), now).delayMs, 60_000);
});

test('po limicie awarii nadzorca zatrzymuje pętlę', () => {
    const now = 1_000_000;
    const attempts = new Array(RESTART_MAX_ATTEMPTS).fill(now - 1);

    assert.deepEqual(decideLoggerRestart(1, attempts, now).reason, 'limit');
    assert.equal(decideLoggerRestart(1, attempts, now).restart, false);
});

test('stare awarie wypadają z okna i nie blokują późniejszego restartu', () => {
    const now = 2_000_000;
    const attempts = new Array(RESTART_MAX_ATTEMPTS).fill(now - RESTART_WINDOW_MS - 1);
    const decision = decideLoggerRestart(1, attempts, now);

    assert.equal(decision.restart, true);
    assert.equal(decision.attempt, 1);
    assert.equal(decision.delayMs, 5000);
});

test('czyste wyjście i utrata autoryzacji nie są ponawiane', () => {
    assert.equal(decideLoggerRestart(0, []).reason, 'clean_exit');
    assert.equal(decideLoggerRestart(EXIT_AUTH_FAILURE, []).reason, 'auth_failure');
});

test('brak zeskanowanego kodu QR nie jest ponawiany', () => {
    const decision = decideLoggerRestart(EXIT_QR_UNSCANNED, []);

    assert.equal(decision.reason, 'qr_unscanned');
    assert.equal(decision.restart, false);
    assert.equal(decision.delayMs, 0);
});

test('tylko LOGOUT przechodzi do nowego QR bez restartowania przeglądarki', () => {
    assert.equal(shouldRelinkWithoutRestart('LOGOUT'), true);
    assert.equal(shouldRelinkWithoutRestart(' logout '), true);
    assert.equal(shouldRelinkWithoutRestart('UNPAIRED'), false);
    assert.equal(shouldRelinkWithoutRestart('NAVIGATION'), false);
});
