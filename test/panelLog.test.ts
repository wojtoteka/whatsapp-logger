import test from 'node:test';
import assert from 'node:assert/strict';
import { ABORTED_REQUEST_NOTE, createPanelOutputFilter } from '../src/panelLog';

/** Dokładnie to, co Next.js wypisuje po zerwanym przez przeglądarkę żądaniu. */
const BLOK = [
    '⨯ Error: The destination stream closed early.',
    '    at ignore-listed frames {',
    "  digest: '3376794223'",
    '}',
];

/** Wynik filtra dla całej listy linii, bez tych, które mają przepaść. */
function przefiltruj(lines: readonly string[]): string[] {
    const filter = createPanelOutputFilter();
    return lines.map(filter).filter((line): line is string => line !== null);
}

test('zerwane żądanie jest tłumaczone raz, a jego ramki stosu znikają', () => {
    assert.deepEqual(przefiltruj(BLOK), [ABORTED_REQUEST_NOTE]);
});

test('kolejne takie same bloki znikają w całości', () => {
    assert.deepEqual(przefiltruj([...BLOK, ...BLOK, ...BLOK]), [ABORTED_REQUEST_NOTE]);
});

test('zwykłe linie panelu przechodzą bez zmian, także tuż po bloku', () => {
    const lines = ['✓ Ready in 932ms', ...BLOK, 'GET /czat/mama 200 in 41ms'];
    assert.deepEqual(przefiltruj(lines), [
        '✓ Ready in 932ms',
        ABORTED_REQUEST_NOTE,
        'GET /czat/mama 200 in 41ms',
    ]);
});

test('inny błąd panelu nadal wychodzi na wierzch razem ze stosem', () => {
    const inny = [
        '⨯ Error: ENOENT: no such file or directory',
        '    at Object.readFileSync (node:fs:442:20) {',
        "  digest: '1234'",
        '}',
    ];
    assert.deepEqual(przefiltruj(inny), inny);
});

test('wcięta linia bez poprzedzającego bloku nie jest połykana', () => {
    assert.deepEqual(przefiltruj(['    at coś (plik.js:1:1)']), ['    at coś (plik.js:1:1)']);
});
