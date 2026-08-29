import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describeError, Log } from '../src/log';
import { withTempDir } from './helpers';

/** Podmienia strumienie konsoli na bufory, żeby dało się je sprawdzić. */
function captureOutput(run: () => void): { out: string; err: string } {
    const captured = { out: '', err: '' };

    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);

    process.stdout.write = ((chunk: string) => {
        captured.out += chunk;
        return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
        captured.err += chunk;
        return true;
    }) as typeof process.stderr.write;

    try {
        run();
    } finally {
        process.stdout.write = stdout;
        process.stderr.write = stderr;
    }
    return captured;
}

test('poziom logowania ucina to, co poniżej progu', () => {
    const log = new Log();
    log.setLevel('warn');

    const { out, err } = captureOutput(() => {
        log.debug('szczegół');
        log.info('informacja');
        log.warn('ostrzeżenie');
    });

    assert.equal(out, '');
    assert.ok(err.includes('ostrzeżenie'));
    assert.ok(!err.includes('informacja'));
});

test('komunikat "raz na uruchomienie" nie powtarza się', () => {
    const log = new Log();
    log.setLevel('info');

    const { err } = captureOutput(() => {
        log.once('klucz', 'tylko raz');
        log.once('klucz', 'tylko raz');
        log.once('klucz', 'tylko raz');
    });

    assert.equal(err.split('tylko raz').length - 1, 1);
});

test('błąd bez treści ze zminifikowanej przeglądarki nadal coś mówi', () => {
    // WhatsApp Web rzuca obiektami w rodzaju "r" z pustym message -
    // samo err.message dawało w poprzedniej wersji pustą linię.
    const minified = new Error('');
    minified.name = 'r';

    assert.equal(describeError(minified), 'r (błąd bez treści)');
    assert.equal(describeError(new Error('coś padło')), 'coś padło');
    assert.equal(describeError('zwykły napis'), 'zwykły napis');
    assert.equal(describeError(null), '(bez treści)');
    assert.equal(describeError({ kod: 500 }), '{"kod":500}');
});

test('błędy trafiają do pliku diagnostycznego razem z kontekstem', async () => {
    await withTempDir(async (dir) => {
        const log = new Log();
        log.setLevel('error');
        log.setErrorFile(dir);

        captureOutput(() => {
            log.error('Nie udało się pobrać', new Error('sieć padła'), {
                stage: 'media',
                chat: 'Ala',
            });
        });

        const entries = JSON.parse(await fs.readFile(path.join(dir, '_bledy.json'), 'utf8')) as Array<
            Record<string, unknown>
        >;

        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.etap, 'media');
        assert.equal(entries[0]?.czat, 'Ala');
        assert.equal(entries[0]?.blad, 'sieć padła');
    });
});

test('cichy błąd idzie do pliku, ale nie na konsolę', async () => {
    await withTempDir(async (dir) => {
        const log = new Log();
        log.setLevel('info');
        log.setErrorFile(dir);

        const { out, err } = captureOutput(() => {
            log.quiet(new Error('spodziewany'), { stage: 'getChat' });
        });

        assert.equal(out, '');
        assert.equal(err, '');

        const entries = JSON.parse(await fs.readFile(path.join(dir, '_bledy.json'), 'utf8')) as unknown[];
        assert.equal(entries.length, 1);
    });
});

test('plik z błędami nie rośnie w nieskończoność', async () => {
    await withTempDir(async (dir) => {
        const log = new Log();
        log.setLevel('error');
        log.setErrorFile(dir);

        captureOutput(() => {
            for (let i = 0; i < 250; i++) log.quiet(new Error(`błąd ${i}`), { stage: 'test' });
        });

        const entries = JSON.parse(await fs.readFile(path.join(dir, '_bledy.json'), 'utf8')) as unknown[];
        assert.equal(entries.length, 200);
    });
});

test('bez ustawionego pliku błędów logowanie nadal działa', () => {
    const log = new Log();
    log.setLevel('error');

    const { err } = captureOutput(() => {
        log.error('bez pliku', new Error('x'));
    });

    assert.ok(err.includes('bez pliku'));
});
