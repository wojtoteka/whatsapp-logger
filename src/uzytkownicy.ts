// Zakładanie kont do panelu z wiersza poleceń.
//
//     npm start -- --uzytkownik
//     npm start -- --uzytkownik wojtek
//
// Hasło jest pytane interaktywnie i nie widać go przy wpisywaniu - nie
// podajemy go argumentem, bo argumenty zostają w historii powłoki
// i widać je na liście procesów.

import readline from 'node:readline';
import { Writable } from 'node:stream';
import type { Config } from './config';
import { Database } from './db';
import { hashPassword, normalizeLogin, passwordProblem } from './haslo';
import { log } from './log';

/** Obsługuje --uzytkownik. Zwraca kod wyjścia. */
export async function manageUsers(config: Config, argv: string[]): Promise<number> {
    if (!config.dbEnabled) {
        log.error('Konta panelu trzymane są w bazie, a DB_ENABLED jest wyłączone.');
        log.info('Włącz DB_ENABLED=true w .env i uzupełnij dane dostępowe, potem spróbuj ponownie.');
        return 1;
    }

    const db = new Database(config);
    const connected = await db.connect();
    log.info(connected.message);
    if (!connected.ok) return 1;

    try {
        const index = argv.findIndex((arg) => arg === '--uzytkownik' || arg === '--user');
        const fromArgs = argv[index + 1];
        const given = fromArgs && !fromArgs.startsWith('--') ? fromArgs : null;

        const existing = await db.listUsers();
        if (existing.length > 0) {
            log.info(`Istniejące konta: ${existing.join(', ')}`);
        } else {
            log.info('Nie ma jeszcze żadnego konta do panelu.');
        }

        const login = normalizeLogin(given ?? (await ask('Login: ')));
        if (login.length === 0) {
            log.error('Login nie może być pusty.');
            return 1;
        }

        const password = await askHidden('Hasło (nie będzie widoczne): ');
        const problem = passwordProblem(password);
        if (problem) {
            log.error(`Nie zapisano: ${problem}.`);
            return 1;
        }

        const repeated = await askHidden('Powtórz hasło: ');
        if (password !== repeated) {
            log.error('Hasła się różnią - nic nie zmieniam.');
            return 1;
        }

        const created = await db.upsertUser(login, await hashPassword(password));
        log.info(created ? `✓ Konto "${login}" założone.` : `✓ Hasło konta "${login}" zmienione.`);
        log.info('Zaloguj się w panelu pod http://localhost:' + String(config.panelPort));
        return 0;
    } finally {
        await db.close();
    }
}

function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

/**
 * To samo, ale bez pokazywania wpisywanych znaków. Strumień wyjścia
 * przepuszcza tylko samo pytanie, resztę połyka.
 */
function askHidden(question: string): Promise<string> {
    let muted = false;

    const output = new Writable({
        write(chunk, _encoding, callback) {
            if (!muted) process.stdout.write(chunk);
            callback();
        },
    });

    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            muted = false;
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
        muted = true;
    });
}
