import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    formatBytes,
    formatHours,
    phoneDigits,
    readJson,
    safeFileName,
    writeJsonAtomic,
} from '../src/util';
import { withTempDir } from './helpers';

test('nazwa czatu zamienia się w nazwę folderu, którą Windows przyjmie', () => {
    assert.equal(safeFileName('Jan Kowalski'), 'Jan_Kowalski');
    assert.equal(safeFileName('Firma: dział "IT"/HR'), 'Firma_dział_ITHR');
    assert.equal(safeFileName('Anna-Maria'), 'Anna-Maria');
});

test('nazwa złożona z samych zakazanych znaków nie kończy się pustym napisem', () => {
    // Pusty napis rozwaliłby ścieżkę - folder powstałby o poziom wyżej.
    assert.equal(safeFileName('///', 'zapas'), 'zapas');
    assert.equal(safeFileName(''), 'bez_nazwy');
    assert.equal(safeFileName('   '), 'bez_nazwy');
});

test('nazwy zarezerwowane w Windowsie dostają przedrostek', () => {
    assert.equal(safeFileName('CON'), '_CON');
    assert.equal(safeFileName('com1'), '_com1');
    assert.equal(safeFileName('CONtakt'), 'CONtakt');
});

test('kropka na początku i na końcu nie zostaje w nazwie folderu', () => {
    assert.equal(safeFileName('.ukryty'), 'ukryty');
    assert.equal(safeFileName('nazwa...'), 'nazwa');
});

test('długa nazwa jest przycinana do limitu', () => {
    const name = safeFileName('x'.repeat(200));
    assert.equal(name.length, 80);
});

test('numer telefonu poznajemy tylko po samych cyfrach właściwej długości', () => {
    assert.equal(phoneDigits('5550100@c.us'), '5550100');
    assert.equal(phoneDigits({ _serialized: '5550100@c.us' }), '5550100');
    assert.equal(phoneDigits('12345@c.us'), null, 'za krótkie, żeby być numerem');
    assert.equal(phoneDigits('abc@c.us'), null);
    assert.equal(phoneDigits(null), null);
});

test('rozmiary i godziny czyta się po ludzku', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(null), null);
    assert.equal(formatBytes(-1), null);

    assert.equal(formatHours(6), '6 h');
    assert.equal(formatHours(0.5), '30 min');
    assert.equal(formatHours(1.5), '1.5 h');
});

test('zapis JSON-a jest niepodzielny i nie zostawia pliku tymczasowego', async () => {
    await withTempDir(async (dir) => {
        const file = path.join(dir, 'głęboko', 'stan.json');
        await writeJsonAtomic(file, { a: 1 });

        assert.deepEqual(await readJson(file), { a: 1 });
        assert.equal(await exists(`${file}.tmp`), false);

        // Nadpisanie ma podmienić zawartość, a nie dopisać do starej.
        await writeJsonAtomic(file, { b: 2 });
        assert.deepEqual(await readJson(file), { b: 2 });
    });
});

test('równoległe zapisy tego samego pliku nie zabierają sobie pliku tymczasowego', async () => {
    await withTempDir(async (dir) => {
        // Dokładnie ta sytuacja, która wywalała historię zdjęć profilowych:
        // przegląd cykliczny i przychodząca wiadomość zapisywały ten sam plik
        // naraz, więc rename() drugiego z nich kończył się błędem ENOENT.
        const file = path.join(dir, '_avatars', '_historia.json');

        const results = await Promise.allSettled(
            Array.from({ length: 20 }, (_, index) => writeJsonAtomic(file, { numer: index })),
        );

        const odrzucone = results.filter((result) => result.status === 'rejected');
        assert.deepEqual(
            odrzucone.map((result) => (result as PromiseRejectedResult).reason),
            [],
            'żaden zapis nie ma prawa się wywrócić',
        );

        // Plik jest kompletny, a nie sklejony z dwóch zapisów naraz.
        const saved = await readJson<{ numer: number }>(file);
        assert.equal(typeof saved?.numer, 'number');

        const leftovers = (await fs.readdir(path.dirname(file))).filter((name) =>
            name.endsWith('.tmp'),
        );
        assert.deepEqual(leftovers, [], 'po zapisach nie zostaje żaden plik tymczasowy');
    });
});

test('ostatni zlecony zapis wygrywa, niezależnie od kolejności zakończeń', async () => {
    await withTempDir(async (dir) => {
        const file = path.join(dir, 'stan.json');

        await Promise.all([
            writeJsonAtomic(file, { kto: 'pierwszy' }),
            writeJsonAtomic(file, { kto: 'drugi' }),
            writeJsonAtomic(file, { kto: 'trzeci' }),
        ]);

        assert.deepEqual(await readJson(file), { kto: 'trzeci' });
    });
});

test('uszkodzony JSON czyta się jako null, zamiast wywracać program', async () => {
    await withTempDir(async (dir) => {
        const file = path.join(dir, 'zepsuty.json');
        await fs.writeFile(file, '{ to nie jest json', 'utf8');

        assert.equal(await readJson(file), null);
        assert.equal(await readJson(path.join(dir, 'nie-ma-mnie.json')), null);
    });
});

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}
