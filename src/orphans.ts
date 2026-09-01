// Sprzątanie przeglądarek, które przeżyły poprzednie uruchomienie.
//
// Puppeteer odpala Chrome jako proces odłączony: własna grupa, własna sesja,
// a po śmierci loggera - rodzic PID 1. Taki sierota nie robi już nic
// pożytecznego, za to trzyma otwarty profil sesji przekazany w
// --user-data-dir. Kolejny start zastaje wtedy zajęty katalog, przeglądarka
// nie wstaje, launcher ponawia logger - i każde ponowienie dokłada następnego
// Chrome. Stąd biorą się te po kilka procesów przeglądarki naraz.
//
// Dlatego przed podniesieniem własnej przeglądarki sprawdzamy, czy pod naszym
// profilem nie siedzi już czyjś Chrome, i jeśli tak - zabieramy go.

import fs from 'node:fs';
import path from 'node:path';
import { processAlive } from './util';

const USER_DATA_ARG = '--user-data-dir=';

/** Katalog profilu, który whatsapp-web.js przekazuje przeglądarce. */
export function sessionProfileDir(rootDir: string): string {
    return path.join(rootDir, '.wwebjs_auth', 'session');
}

/**
 * Czy ta linia poleceń to Chrome trzymający dokładnie nasz profil.
 *
 * Oba warunki są potrzebne. Sam katalog trafia również do procesów
 * pomocniczych (renderer, GPU, sieć) i te też chcemy zabrać, ale nazwa
 * programu odsiewa wszystko spoza rodziny Chrome - łącznie z chwilowym
 * "grep --user-data-dir=..." w cudzej konsoli.
 *
 * Nazwy szukamy w środku, a nie na początku: pakiet Google'a przedstawia się
 * jako "google-chrome", a kopia puppeteera po prostu jako "chrome".
 */
export function isOurBrowser(argv: readonly string[], profileDir: string): boolean {
    const program = path.basename(argv[0] ?? '').toLowerCase();
    if (!program.includes('chrome') && !program.includes('chromium')) return false;
    // chrome_crashpad_handler nie dostaje --user-data-dir, więc odpada niżej
    // sam z siebie. Ginie razem z przeglądarką, którą pilnuje.

    const wanted = path.resolve(profileDir);
    return argv.slice(1).some((arg) => {
        if (!arg.startsWith(USER_DATA_ARG)) return false;
        return path.resolve(arg.slice(USER_DATA_ARG.length)) === wanted;
    });
}

/** Argumenty procesu z /proc. null, gdy proces zniknął albo nie ma dostępu. */
function readProcessArgv(pid: number): string[] | null {
    try {
        const raw = fs.readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8');
        const argv = raw.split('\0').filter((part) => part.length > 0);
        return argv.length > 0 ? argv : null;
    } catch {
        return null;
    }
}

/** PID rodzica i grupy procesów, odczytane z /proc/PID/stat. */
export interface ProcInfo {
    ppid: number;
    pgid: number;
}

/**
 * Czy ta przeglądarka została bez opiekuna.
 *
 * To jedyne, co dzieli sierotę do zabrania od przeglądarki pracującego
 * loggera. Bez tego warunku drugie "npm start" ubiłoby pierwszemu sesję.
 * Sierota ma rodzica PID 1 albo takiego, którego już nie ma; deadParents to
 * procesy zabite przed chwilą, które jądro może jeszcze pokazywać jako żywe.
 */
export function isAbandoned(
    info: ProcInfo,
    deadParents: readonly number[] = [],
    alive: (pid: number) => boolean = processAlive,
): boolean {
    if (info.ppid === 1) return true;
    if (deadParents.includes(info.ppid)) return true;
    return !alive(info.ppid);
}

/**
 * Nazwa programu w /proc/PID/stat stoi w nawiasach i sama może zawierać
 * nawiasy oraz spacje, więc liczymy pola dopiero za jej ostatnim nawiasem.
 * Dalej idą kolejno: stan, PPID, PGID.
 */
function readProcInfo(pid: number): ProcInfo | null {
    try {
        const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
        return { ppid, pgid };
    } catch {
        return null;
    }
}

/**
 * Zabija przeglądarki trzymające nasz profil, które zostały bez opiekuna.
 * Zwraca ich PID-y - do wypisania, żeby było widać, że coś tam siedziało.
 *
 * Warunek sieroctwa jest tu po to, żeby drugie "npm start" nie ubiło pierwszego:
 * przeglądarka pracującego loggera ma go nadal jako rodzica, więc jej nie ruszamy.
 * Osierocona ma rodzica PID 1 - albo takiego, którego już nie ma.
 *
 * deadParents to PID-y procesów, które właśnie zabiliśmy i które jądro może
 * jeszcze przez moment pokazywać jako żywe. Bez tej listy sprzątanie tuż po
 * SIGKILL na loggera nie uznałoby jego przeglądarki za sierotę.
 */
export function killOrphanBrowsers(profileDir: string, deadParents: readonly number[] = []): number[] {
    // /proc jest linuksowe. Na Windowsie puppeteer nie odłącza przeglądarki,
    // więc problem sierot tam nie występuje i nie ma czego szukać.
    if (process.platform === 'win32') return [];

    let entries: string[];
    try {
        entries = fs.readdirSync('/proc');
    } catch {
        return [];
    }

    const killed: number[] = [];
    for (const entry of entries) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;

        const argv = readProcessArgv(pid);
        if (!argv || !isOurBrowser(argv, profileDir)) continue;

        const info = readProcInfo(pid);
        if (!info || !isAbandoned(info, deadParents)) continue;

        try {
            // Odłączona przeglądarka jest liderem własnej grupy, więc minus
            // przed PID-em zabiera od razu jej renderery i procesy pomocnicze.
            // Gdyby liderem nie była, bierzemy sam proces: cudzej grupy nie
            // wolno nam tknąć nawet przypadkiem.
            if (info.pgid === pid) process.kill(-pid, 'SIGKILL');
            else process.kill(pid, 'SIGKILL');
            killed.push(pid);
        } catch {
            // Zniknął sam między odczytem a zabiciem - tym lepiej.
        }
    }
    return killed;
}
