// Uruchamia loggera i panel jednym poleceniem.
//
//     npm start
//
// Logger pisze wprost na konsolę - kod QR musi być widoczny w całości,
// więc jego wyjście idzie bez żadnych ozdobników. Panel dostaje przedrostek,
// żeby było wiadomo, od kogo jest która linijka.
//
// Panel czyta ten sam folder logs, co logger: ścieżkę przekazujemy mu wprost,
// więc nie da się ich rozjechać przez dwie różne konfiguracje.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../src/config';

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PANEL_DIR = path.join(ROOT_DIR, 'panel');

/**
 * CLI Next.js odpalamy wprost Nodem, a nie przez npx.
 *
 * Na Windowsie npx to plik .cmd, a Node od wersji 20 odmawia uruchamiania
 * .cmd bez powłoki (spawn EINVAL). Sięgnięcie po sam skrypt omija ten problem
 * i przy okazji nie zależy od tego, co siedzi w PATH - tak samo tu i na serwerze.
 */
const NEXT_BIN = path.join(PANEL_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');

/** Ile najdłużej czekamy, aż logger dopisze oczekujące wiadomości. */
const SHUTDOWN_TIMEOUT_MS = 20_000;

const children: Array<{ name: string; child: ChildProcess }> = [];
let stopping = false;

function main(): void {
    const { config } = loadConfig(ROOT_DIR);

    startLogger();

    if (!config.panelEnabled) {
        console.log('[panel] wyłączony (PANEL_ENABLED=false)');
        return;
    }
    if (!fs.existsSync(PANEL_DIR)) {
        console.log('[panel] pominięty - nie ma folderu panel/');
        return;
    }
    if (!fs.existsSync(NEXT_BIN)) {
        console.log('[panel] pominięty - brak zależności. Zainstaluj je: npm run panel:build');
        return;
    }
    ostrzezOBrakuKlucza();
    startPanel(config.logsDir, config.panelHost, config.panelPort);
}

/**
 * Bez AUTH_SECRET Auth.js nie podpisze sesji i panel wywali się dopiero
 * przy pierwszym wejściu na stronę. Lepiej powiedzieć to od razu.
 */
function ostrzezOBrakuKlucza(): void {
    if (process.env.AUTH_SECRET) return;

    let plik = '';
    try {
        plik = fs.readFileSync(path.join(PANEL_DIR, '.env'), 'utf8');
    } catch {
        console.log('[panel] nie ma panel/.env - skopiuj panel/.env.example i uzupełnij.');
        return;
    }

    if (!/^\s*AUTH_SECRET\s*=\s*\S/m.test(plik)) {
        console.log('[panel] w panel/.env brakuje AUTH_SECRET - logowanie nie zadziała.');
        console.log('[panel] wygeneruj go poleceniem:  cd panel && npx auth secret');
    }
}

/** Logger dostaje konsolę na wyłączność - inaczej kod QR by się rozjechał. */
function startLogger(): void {
    const child = spawn(process.execPath, [path.join(ROOT_DIR, 'dist', 'index.js')], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
    });
    track('logger', child);
}

function startPanel(logsDir: string, host: string, port: number): void {
    // Panel bez zbudowanych stron nie wystartuje, więc przy pierwszym
    // uruchomieniu budujemy go sami, zamiast wywalać się z błędem.
    const built = fs.existsSync(path.join(PANEL_DIR, '.next', 'BUILD_ID'));

    const env = {
        ...process.env,
        LOGS_DIR: logsDir,
        HOSTNAME: host,
        PORT: String(port),
    };

    if (!built) {
        console.log('[panel] pierwsze uruchomienie - buduję panel, to potrwa chwilę...');
        const build = spawn(process.execPath, [NEXT_BIN, 'build'], {
            cwd: PANEL_DIR,
            env,
            stdio: 'ignore',
        });

        build.on('exit', (code) => {
            if (stopping) return;
            if (code !== 0) {
                console.error(`[panel] budowanie nie powiodło się (kod ${String(code)}).`);
                console.error('[panel] spróbuj ręcznie: cd panel && npm install && npm run build');
                return;
            }
            console.log('[panel] zbudowany.');
            runPanel(env, host, port);
        });
        return;
    }

    runPanel(env, host, port);
}

function runPanel(env: NodeJS.ProcessEnv, host: string, port: number): void {
    const child = spawn(process.execPath, [NEXT_BIN, 'start', '-H', host, '-p', String(port)], {
        cwd: PANEL_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    prefix(child, '[panel]');
    track('panel', child);

    console.log(`[panel] archiwum pod adresem ${adresPanelu(host, port)}`);
}

/**
 * Adres do wklejenia w przeglądarkę. 0.0.0.0 znaczy "nasłuchuj na wszystkim"
 * i jako adres do wpisania się nie nadaje - wtedy podpowiadamy localhost.
 */
function adresPanelu(host: string, port: number): string {
    const widoczny = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    const wKlamrach = widoczny.includes(':') ? `[${widoczny}]` : widoczny;
    return `http://${wKlamrach}:${String(port)}`;
}

/** Dokleja przedrostek do każdej linijki, żeby nie mieszać się z loggerem. */
function prefix(child: ChildProcess, label: string): void {
    for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        readline.createInterface({ input: stream }).on('line', (line) => {
            if (line.trim().length > 0) console.log(`${label} ${line}`);
        });
    }
}

function track(name: string, child: ChildProcess): void {
    children.push({ name, child });

    child.on('error', (err) => {
        console.error(`[${name}] nie udało się uruchomić: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
        if (stopping) return;
        console.log(`[${name}] zakończony (${signal ?? `kod ${String(code)}`}).`);

        // Jeden bez drugiego nie ma sensu: panel bez loggera pokazuje
        // zamrożone archiwum, logger bez panelu to nie jest to, co ustawiono.
        stopAll(code ?? 1);
    });
}

/**
 * Zamykanie. Logger ma dopisać do archiwum to, co czeka w pamięci, więc go
 * nie dobijamy - dostaje sygnał i tyle czasu, ile potrzebuje.
 *
 * Na Windowsie Ctrl+C trafia sam do wszystkich procesów tej konsoli, więc
 * logger dowiaduje się o zamykaniu niezależnie od nas. Na Linuksie wysyłamy
 * mu SIGTERM, bo przy uruchomieniu w tle sygnał może do niego nie dojść.
 */
function stopAll(code: number): void {
    if (stopping) return;
    stopping = true;

    for (const { name, child } of children) {
        if (child.exitCode !== null || child.killed) continue;

        if (name === 'logger' && process.platform !== 'win32') {
            child.kill('SIGTERM');
        } else if (name !== 'logger') {
            child.kill();
        }
    }

    waitForLogger(code, Date.now() + SHUTDOWN_TIMEOUT_MS);
}

/** Sprawdza co chwilę, czy logger już skończył zapisywać. */
function waitForLogger(code: number, deadline: number): void {
    const logger = children.find((c) => c.name === 'logger');

    if (!logger || logger.child.exitCode !== null || Date.now() > deadline) {
        if (logger && logger.child.exitCode === null) {
            console.error('[logger] nie zamknął się na czas - kończę.');
            logger.child.kill();
        }
        process.exit(code);
    }
    setTimeout(() => waitForLogger(code, deadline), 250).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        stopAll(0);
    });
}

main();
