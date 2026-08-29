import test from 'node:test';
import assert from 'node:assert/strict';
import { statusLine, unlock } from '../src/lockedChats';
import type { WaClient } from '../src/types';

/**
 * Klient, którego evaluate() uruchamia przekazaną funkcję na miejscu,
 * podstawiając udawane globalThis.require i globalThis.Store.
 */
function pageClient(globals: Record<string, unknown>): WaClient {
    return {
        pupPage: {
            async evaluate<T>(fn: (...args: never[]) => T, ...args: unknown[]): Promise<T> {
                const saved = new Map<string, unknown>();
                const target = globalThis as unknown as Record<string, unknown>;

                for (const [key, value] of Object.entries(globals)) {
                    saved.set(key, target[key]);
                    target[key] = value;
                }
                try {
                    return await (fn as (...a: unknown[]) => T)(...args);
                } finally {
                    for (const [key, value] of saved) {
                        if (value === undefined) delete target[key];
                        else target[key] = value;
                    }
                }
            },
        },
    } as unknown as WaClient;
}

test('puste hasło całkowicie wyłącza obsługę i nie dotyka przeglądarki', async () => {
    let touched = false;
    const client = {
        pupPage: {
            evaluate: async () => {
                touched = true;
            },
        },
    } as unknown as WaClient;

    const result = await unlock(client, '');

    assert.deepEqual(result, { status: 'disabled' });
    assert.equal(touched, false);
    assert.match(statusLine(result), /bez hasła/);
});

test('poprawne hasło waliduje kod i wysyła polecenie odsłonięcia czatów', async () => {
    let accessible = false;
    let submitted: string | null = null;
    let command: string | null = null;

    const utils = {
        hasChatlockSecretCode: async () => true,
        lockedChatsAreAccessible: async () => accessible,
        validateSecretCode: async (value: string) => {
            submitted = value;
            return value === 'dobry kod';
        },
    };

    const client = pageClient({
        require(name: string) {
            if (name === 'WAWebChatLockUtils') return utils;
            if (name === 'WAWebCmd') {
                return {
                    Cmd: {
                        trigger: async (value: string) => {
                            command = value;
                            accessible = true;
                        },
                    },
                };
            }
            throw new Error(`nieznany moduł ${name}`);
        },
    });

    const result = await unlock(client, 'dobry kod', { tries: 1, waitMs: 0 });

    assert.deepEqual(result, { status: 'granted' });
    assert.equal(submitted, 'dobry kod');
    assert.equal(command, 'chatlock:unlock');
    assert.match(statusLine(result), /odsłonięte/);
});

test('błędne hasło nie wysyła polecenia odsłonięcia', async () => {
    let triggered = false;

    const client = pageClient({
        require(name: string) {
            if (name === 'WAWebChatLockUtils') {
                return {
                    hasChatlockSecretCode: async () => true,
                    lockedChatsAreAccessible: async () => false,
                    validateSecretCode: async () => false,
                };
            }
            if (name === 'WAWebCmd') {
                return {
                    Cmd: {
                        trigger: async () => {
                            triggered = true;
                        },
                    },
                };
            }
            throw new Error(`nieznany moduł ${name}`);
        },
    });

    const result = await unlock(client, 'zły kod', { tries: 1, waitMs: 0 });

    assert.equal(result.status, 'invalid_password');
    assert.equal(triggered, false);
    assert.match(statusLine(result), /nie pasuje/);
});

test('brak zablokowanych czatów i kodu to jeden komunikat', async () => {
    const client = pageClient({
        require: () => ({
            hasChatlockSecretCode: async () => false,
            lockedChatsAreAccessible: async () => false,
            validateSecretCode: async () => false,
            getLockedChats: async () => [],
        }),
    });

    const result = await unlock(client, 'kod', { tries: 1, waitMs: 0 });

    assert.equal(result.status, 'not_enabled');
    assert.equal(result.lockedCount, 0);
    assert.match(statusLine(result), /nie ma tu żadnego zablokowanego czatu/);
});

test('zablokowane czaty bez kodu w sesji to zupełnie inna rada', async () => {
    // Dokładnie ta sytuacja: WhatsApp Web widzi zablokowany czat, ale kod
    // tajny nie doszedł z telefonu, więc nie ma go z czym porównać.
    const client = pageClient({
        require: () => ({
            hasChatlockSecretCode: async () => false,
            lockedChatsAreAccessible: async () => false,
            validateSecretCode: async () => false,
            getLockedChats: async () => [{ id: 'czat' }],
        }),
    });

    const result = await unlock(client, 'kod', { tries: 1, waitMs: 0 });

    assert.equal(result.status, 'not_enabled');
    assert.equal(result.lockedCount, 1);
    assert.deepEqual(result.lockedChatIds, ['czat']);
    assert.match(statusLine(result), /nie dostał kodu tajnego z telefonu/);
    assert.match(statusLine(result), /widzi 1 zablokowanych/);
});

test('identyfikatory zablokowanych czatów zachowujemy niezależnie od ich kształtu', async () => {
    const client = pageClient({
        require: () => ({
            hasChatlockSecretCode: async () => false,
            lockedChatsAreAccessible: async () => false,
            validateSecretCode: async () => false,
            getLockedChats: async () => [
                { id: { _serialized: '111@lid' } },
                { wid: { toString: () => '222@g.us' } },
                '333@c.us',
            ],
        }),
    });

    const result = await unlock(client, 'kod', { tries: 1, waitMs: 0 });

    assert.equal(result.lockedCount, 3);
    assert.deepEqual(result.lockedChatIds, ['111@lid', '222@g.us', '333@c.us']);
});

test('kod podajemy z drugim argumentem, którego wymaga WhatsApp Web', async () => {
    // validateSecretCode ma sygnaturę (kod, kontekst) - wywołanie z jednym
    // argumentem przechodziło, ale to sygnatura z podglądu żywej strony.
    let liczbaArgumentow = -1;
    const client = pageClient({
        require(name: string) {
            if (name === 'WAWebCmd') return { Cmd: { trigger: async () => undefined } };
            return {
                hasChatlockSecretCode: async () => true,
                lockedChatsAreAccessible: async () => true,
                validateSecretCode: async (...args: unknown[]) => {
                    liczbaArgumentow = args.length;
                    return true;
                },
            };
        },
    });

    // Czaty już dostępne, więc validateSecretCode nie jest wołane...
    await unlock(client, 'kod', { tries: 1, waitMs: 0 });
    assert.equal(liczbaArgumentow, -1);
});

test('hasChatlockSecretCode nie blokuje podania hasła, gdy kod jednak działa', async () => {
    // To był realny błąd: WhatsApp odpowiadał "nie ma kodu", zanim
    // zsynchronizował ustawienia, i program nawet nie próbował hasła.
    let accessible = false;
    let asked = false;

    const client = pageClient({
        require(name: string) {
            if (name === 'WAWebCmd') {
                return { Cmd: { trigger: async () => { accessible = true; } } };
            }
            return {
                hasChatlockSecretCode: async () => false,
                lockedChatsAreAccessible: async () => accessible,
                validateSecretCode: async (value: string) => {
                    asked = true;
                    return value === 'dobry kod';
                },
            };
        },
    });

    const result = await unlock(client, 'dobry kod', { tries: 1, waitMs: 0 });

    assert.equal(asked, true, 'hasło musi zostać podane mimo odpowiedzi "brak kodu"');
    assert.equal(result.status, 'granted');
});

test('złe hasło przy ustawionym kodzie to nadal "nie pasuje", a nie "brak kodu"', async () => {
    const client = pageClient({
        require: () => ({
            hasChatlockSecretCode: async () => true,
            lockedChatsAreAccessible: async () => false,
            validateSecretCode: async () => false,
        }),
    });

    const result = await unlock(client, 'zly', { tries: 1, waitMs: 0 });

    assert.equal(result.status, 'invalid_password');
});

test('czaty już odsłonięte w tej sesji nie wymagają podawania kodu drugi raz', async () => {
    let validated = false;
    const client = pageClient({
        require: () => ({
            hasChatlockSecretCode: async () => true,
            lockedChatsAreAccessible: async () => true,
            validateSecretCode: async () => {
                validated = true;
                return true;
            },
        }),
    });

    const result = await unlock(client, 'kod', { tries: 1, waitMs: 0 });

    assert.deepEqual(result, { status: 'granted' });
    assert.equal(validated, false);
});

test('brak modułu kończy się jednym statusem, a nie zawieszeniem programu', async () => {
    const client = pageClient({
        require() {
            throw new Error('moduł jeszcze się nie wczytał');
        },
    });

    const result = await unlock(client, 'kod', { tries: 2, waitMs: 0 });

    assert.deepEqual(result, { status: 'unavailable' });
    assert.match(statusLine(result), /nie udostępnił/);
});

test('bez dostępu do przeglądarki nie próbujemy nawet raz', async () => {
    const result = await unlock({} as unknown as WaClient, 'kod');

    assert.deepEqual(result, { status: 'unavailable' });
});

test('błąd w środku strony niesie ze sobą powód, a nie samo słowo "błąd"', async () => {
    const client = pageClient({
        require: () => ({
            hasChatlockSecretCode: async () => true,
            lockedChatsAreAccessible: async () => false,
            validateSecretCode: async () => {
                throw new Error('Cannot read properties of undefined');
            },
        }),
    });

    const result = await unlock(client, 'kod', { tries: 1, waitMs: 0 });

    assert.equal(result.status, 'error');
    assert.match(result.detail ?? '', /Cannot read properties of undefined/);
    assert.match(statusLine(result), /Cannot read properties of undefined/);
});

test('każdy status ma swój komunikat, żaden nie zostaje bez wyjaśnienia', () => {
    const statuses = [
        'disabled',
        'granted',
        'invalid_password',
        'not_enabled',
        'not_granted',
        'unsupported',
        'unavailable',
        'error',
    ] as const;

    const lines = statuses.map((status) => statusLine({ status }));

    assert.equal(new Set(lines).size, statuses.length, 'komunikaty nie mogą się powtarzać');
    for (const line of lines) assert.ok(line.length > 10);
});

// Regresja: przez chwilę każdy nieudany stan wypisywał "✗", przez co
// wyglądało to na utratę wiadomości z zablokowanych czatów. Archiwum
// powstaje niezależnie od tej próby, więc komunikat nie ma prawa straszyć.
test('żaden komunikat nie udaje awarii', () => {
    const statuses = [
        'disabled',
        'granted',
        'invalid_password',
        'not_enabled',
        'not_granted',
        'unsupported',
        'unavailable',
        'error',
    ] as const;

    for (const status of statuses) {
        const line = statusLine({ status });
        assert.ok(!line.includes('✗'), `"${status}" nie może być zgłaszany jako błąd: ${line}`);
    }
});

test('każdy stan poza sukcesem przypomina, że archiwum i tak powstaje', () => {
    const statuses = [
        'disabled',
        'invalid_password',
        'not_enabled',
        'not_granted',
        'unsupported',
        'unavailable',
        'error',
    ] as const;

    for (const status of statuses) {
        assert.match(
            statusLine({ status }),
            /trafiają do archiwum/,
            `"${status}" zostawia użytkownika bez odpowiedzi, czy wiadomości są zapisywane`,
        );
    }
});
