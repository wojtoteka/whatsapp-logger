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
import type { Server } from 'node:http';
import { isOneShot, normalizeCliArgs } from '../src/cli';
import type { Config } from '../src/config';
import { loadConfig } from '../src/config';
import { createLanGuard, findFreePort } from '../src/lanGuard';
import { killOrphanBrowsers, sessionProfileDir } from '../src/orphans';
import { decideLoggerRestart } from '../src/restart';

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

/** Pod tą nazwą logger dostaje PID launchera - patrz startLogger(). */
const PARENT_PID_ENV = 'WA_LOGGER_PARENT_PID';

// npm 11 na Windowsie zamienia argumenty "--nazwa" w npm_config_nazwa
// zamiast przekazać je procesowi. Składamy z powrotem znane flagi, zachowując
// też zwykłe argumenty, np. login po --uzytkownik.
const loggerArgs = normalizeCliArgs(process.argv.slice(2), process.env);
const oneShot = isOneShot(loggerArgs);

const children: Array<{ name: string; child: ChildProcess }> = [];
/** Bramka wpuszczająca do panelu tylko sieć lokalną - null, gdy wyłączona. */
let guard: Server | null = null;
let stopping = false;
let restartAttempts: number[] = [];
let restartTimer: NodeJS.Timeout | null = null;

function main(): void {
    const { config } = loadConfig(ROOT_DIR);

    startLogger();

    // Polecenia administracyjne mają wykonać jedną rzecz i zakończyć się bez
    // uruchamiania panelu ani automatycznego restartu.
    if (oneShot) return;

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
    startPanel(config);
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
    const child = spawn(process.execPath, [path.join(ROOT_DIR, 'dist', 'index.js'), ...loggerArgs], {
        cwd: ROOT_DIR,
        // Trzy pierwsze strumienie jak dotąd, czwarty to kanał IPC. Nie idzie
        // nim ani jedna wiadomość - liczy się to, że po naszej śmierci potok
        // się zamyka i logger dostaje 'disconnect'. Działa to nawet wtedy, gdy
        // zginiemy od SIGKILL i nie zdążymy nikomu nic powiedzieć.
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        // Zapasowy strażnik, gdyby logger poszedł kiedyś bez kanału IPC.
        env: { ...process.env, [PARENT_PID_ENV]: String(process.pid) },
    });
    track('logger', child);
}

function startPanel(config: Config): void {
    void preparePanel(config).catch((err: unknown) => {
        const powod = err instanceof Error ? err.message : String(err);
        console.error(`[panel] nie udało się przygotować uruchomienia: ${powod}`);
        stopAll(1);
    });
}

/**
 * Z włączoną bramką Next.js słucha wyłącznie na pętli zwrotnej, a z sieci
 * widać tylko bramkę - dzięki temu przekierowanie portu albo DMZ na routerze
 * nie wystawia archiwum całemu internetowi. Bez bramki wszystko zostaje po
 * staremu: panel sam siada na PANEL_HOST:PANEL_PORT.
 */
async function preparePanel(config: Config): Promise<void> {
    const listenHost = config.panelLanOnly ? '127.0.0.1' : config.panelHost;
    const listenPort = config.panelLanOnly ? await findFreePort() : config.panelPort;

    const env = {
        ...process.env,
        LOGS_DIR: config.logsDir,
        HOSTNAME: listenHost,
        PORT: String(listenPort),
    };

    // Budujemy przy każdym zwykłym npm start. Dzięki temu zmiana w panelu nie
    // zostaje przykryta starym panel/.next tylko dlatego, że BUILD_ID już był.
    // Zależności muszą istnieć, ale npm install nie jest tutaj uruchamiane.
    console.log('[panel] buduję aktualną wersję...');
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
        runPanel(env, listenHost, listenPort);
        if (config.panelLanOnly) startGuard(config, listenPort);
        console.log(`[panel] archiwum pod adresem ${adresPanelu(config.panelHost, config.panelPort)}`);
    });
}

function runPanel(env: NodeJS.ProcessEnv, host: string, port: number): void {
    const child = spawn(process.execPath, [NEXT_BIN, 'start', '-H', host, '-p', String(port)], {
        cwd: PANEL_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    prefix(child, '[panel]');
    track('panel', child);
}

/** Stawia bramkę przed panelem i mówi, co dokładnie przepuszcza. */
function startGuard(config: Config, targetPort: number): void {
    // Skaner potrafi pukać setki razy - jeden adres wypisujemy raz.
    const odrzucone = new Set<string>();

    guard = createLanGuard({
        host: config.panelHost,
        port: config.panelPort,
        targetHost: '127.0.0.1',
        targetPort,
        allowed: config.panelAllowedIps,
        onBlocked: (address) => {
            if (odrzucone.has(address) || odrzucone.size >= 50) return;
            odrzucone.add(address);
            console.log(`[panel] odrzucono połączenie spoza sieci lokalnej: ${address}`);
        },
    });

    guard.on('error', (err: Error) => {
        console.error(
            `[panel] bramka nie wstała na ${config.panelHost}:${String(config.panelPort)}: ${err.message}`,
        );
        stopAll(1);
    });

    const dodatkowe =
        config.panelAllowedIps.length > 0
            ? ` Dopuszczone dodatkowo: ${config.panelAllowedIps.join(', ')}.`
            : '';
    console.log(`[panel] wejście tylko z sieci lokalnej.${dodatkowe}`);
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
    let handled = false;

    child.on('error', (err) => {
        console.error(`[${name}] nie udało się uruchomić: ${err.message}`);
        if (handled) return;
        handled = true;
        if (name === 'logger') handleLoggerExit(1);
        else stopAll(1);
    });

    child.on('exit', (code, signal) => {
        if (stopping || handled) return;
        handled = true;
        console.log(`[${name}] zakończony (${signal ?? `kod ${String(code)}`}).`);

        if (name === 'logger') {
            handleLoggerExit(code);
            return;
        }

        // Jeden bez drugiego nie ma sensu: panel bez loggera pokazuje
        // zamrożone archiwum, logger bez panelu to nie jest to, co ustawiono.
        stopAll(code ?? 1);
    });
}

/** Ponawia wyłącznie logger; panel może przez chwilę pokazywać ostatni stan. */
function handleLoggerExit(code: number | null): void {
    if (oneShot) {
        stopAll(code ?? 1);
        return;
    }

    const now = Date.now();
    const decision = decideLoggerRestart(code, restartAttempts, now);
    restartAttempts = decision.recentAttempts;

    if (!decision.restart) {
        if (decision.reason === 'auth_failure') {
            console.error('[logger] utrata autoryzacji wymaga ponownego sparowania - nie restartuję.');
        } else if (decision.reason === 'qr_unscanned') {
            console.error('[logger] nikt nie zeskanował kodu QR - nie restartuję.');
        } else if (decision.reason === 'limit') {
            console.error('[logger] zbyt wiele awarii w 15 minut - zatrzymuję automatyczne restarty.');
        }
        stopAll(code ?? 1);
        return;
    }

    restartAttempts.push(now);
    console.log(
        `[logger] ponawiam za ${String(decision.delayMs / 1000)} s ` +
            `(próba ${String(decision.attempt)}/8).`,
    );
    restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!stopping) startLogger();
    }, decision.delayMs);
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
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    if (guard) {
        guard.close();
        guard = null;
    }

    for (const { name, child } of children) {
        if (!zyje(child)) continue;

        if (name === 'logger' && process.platform !== 'win32') {
            child.kill('SIGTERM');
        } else if (name !== 'logger') {
            child.kill();
        }
    }

    waitForLogger(code, Date.now() + SHUTDOWN_TIMEOUT_MS);
}

/**
 * Czy dziecko jeszcze pracuje.
 *
 * Sam exitCode nie wystarczy: proces zakończony sygnałem ma tam null, a swój
 * numer sygnału w signalCode. Poprzedni warunek uznawał więc zabitego loggera
 * za wciąż żywego - czekał na niego pełne 20 sekund i wypisywał nieprawdę.
 * Nie patrzymy też na killed: to znaczy tylko tyle, że sygnał został wysłany.
 */
function zyje(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
}

/** Sprawdza co chwilę, czy logger już skończył zapisywać. */
function waitForLogger(code: number, deadline: number): void {
    const logger = children.findLast((c) => c.name === 'logger');

    if (!logger || !zyje(logger.child) || Date.now() > deadline) {
        if (logger && zyje(logger.child)) {
            // SIGTERM poszedł na początku zamykania i nie poskutkował: logger
            // albo wisi w zapisie, albo jest w trakcie własnego zamykania i
            // drugiego takiego sygnału już nie obsłuży. Zostaje SIGKILL -
            // poprzednia wersja wysyłała tu ponownie SIGTERM, czyli nic.
            console.error('[logger] nie zamknął się na czas - zabijam.');
            logger.child.kill('SIGKILL');
        }
        process.exit(code);
    }
    setTimeout(() => waitForLogger(code, deadline), 250).unref();
}

// SIGHUP jest tu równie ważny jak Ctrl+C. Dostajemy go, gdy znika terminal -
// czyli przy każdym zamknięciu połączenia SSH. Bez tej obsługi launcher ginął
// na miejscu, nie zdążywszy zatrzymać dzieci: logger, panel i Chromium
// zostawały jako sieroty pod PID 1, mielące procesor aż do ręcznego zabicia.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
        stopAll(0);
    });
}

// Ostatnia siatka: cokolwiek by nas nie zakończyło - błąd, process.exit() -
// dzieci mają odejść razem z nami. kill() jest wywołaniem systemowym, więc
// wolno go użyć nawet tutaj, gdzie nic asynchronicznego już się nie wykona.
//
// Idzie SIGKILL, a nie SIGTERM: na łagodne pożegnanie było miejsce wyżej,
// tutaj nikt już nie zaczeka na to, co dziecko zechce jeszcze zrobić.
process.on('exit', () => {
    const dobiteLoggery: number[] = [];
    for (const { name, child } of children) {
        if (!zyje(child)) continue;
        child.kill('SIGKILL');
        if (name === 'logger' && child.pid !== undefined) dobiteLoggery.push(child.pid);
    }

    // Zabity twardo logger nie zdążył zamknąć swojej przeglądarki, a nikt inny
    // tego nie zrobi: puppeteer odpala Chrome odłączonego, z własną grupą
    // procesów i własną sesją, więc nie dociera do niego ani Ctrl+C, ani SIGHUP
    // po zerwaniu SSH. Zostawiony sam sobie trzyma profil w .wwebjs_auth
    // i blokuje następne uruchomienie.
    if (dobiteLoggery.length === 0) return;
    const zabite = killOrphanBrowsers(sessionProfileDir(ROOT_DIR), dobiteLoggery);
    if (zabite.length > 0) {
        console.error(`[logger] zamknąłem też jego przeglądarkę (PID ${zabite.join(', ')}).`);
    }
});

main();
