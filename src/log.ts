// Wypisywanie na konsolę i do pliku z błędami.
//
// Osobny moduł jest tu z jednego konkretnego powodu: pasek postępu
// ("Ładowanie: 30%") pisze się w kółko w tej samej linii przez \r. Każdy
// zwykły komunikat musi najpierw tę linię wyczyścić, inaczej doklei się
// do niej w połowie - dokładnie tak, jak wyglądało to w poprzedniej wersji.

import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from './config';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Ile wpisów trzymamy w pliku z błędami, zanim najstarsze wylecą. */
const ERROR_FILE_LIMIT = 200;

export interface ErrorContext {
    /** Co program akurat robił, np. "pobieranie mediów". */
    stage?: string;
    chat?: string | null;
    messageId?: string | null;
    messageType?: string | null;
}

export class Log {
    private level: LogLevel = 'info';
    private errorFile: string | null = null;
    /** Czy w konsoli wisi niedokończona linia postępu do wyczyszczenia. */
    private progressWidth = 0;
    /** Komunikaty, które mają polecieć tylko raz na uruchomienie. */
    private readonly saidOnce = new Set<string>();

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    /** Włącza zapis błędów do pliku w podanym folderze archiwum. */
    setErrorFile(logsDir: string): void {
        this.errorFile = path.join(logsDir, '_bledy.json');
    }

    // ── Linia postępu ────────────────────────────────────────────────────

    /**
     * Pisze w kółko po tej samej linii. Nie jest to komunikat, tylko stan,
     * więc nie trafia do pliku i znika, gdy przestanie być aktualny.
     */
    progress(text: string): void {
        if (RANK[this.level] > RANK.info) return;
        if (!process.stdout.isTTY) return;

        this.clearProgress();
        process.stdout.write(text);
        this.progressWidth = text.length;
    }

    /** Zdejmuje linię postępu z ekranu, jeśli jakaś wisi. */
    private clearProgress(): void {
        if (this.progressWidth === 0) return;
        process.stdout.write(`\r${' '.repeat(this.progressWidth)}\r`);
        this.progressWidth = 0;
    }

    /** Kończy pasek postępu na dobre - kolejny start zacznie od nowa. */
    endProgress(): void {
        this.clearProgress();
    }

    // ── Zwykłe komunikaty ────────────────────────────────────────────────

    debug(message: string): void {
        this.write('debug', message);
    }

    info(message: string): void {
        this.write('info', message);
    }

    warn(message: string): void {
        this.write('warn', message);
    }

    /** Komunikat wypisywany najwyżej raz na uruchomienie programu. */
    once(key: string, message: string, level: LogLevel = 'warn'): void {
        if (this.saidOnce.has(key)) return;
        this.saidOnce.add(key);
        this.write(level, message);
    }

    /** Pusta linia - do rozdzielania bloków, nie idzie do pliku. */
    blank(): void {
        if (RANK[this.level] > RANK.info) return;
        this.clearProgress();
        process.stdout.write('\n');
    }

    private write(level: LogLevel, message: string): void {
        if (RANK[level] < RANK[this.level]) return;
        this.clearProgress();

        const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
        stream.write(`${message}\n`);
    }

    // ── Błędy ────────────────────────────────────────────────────────────

    /**
     * Błąd wart pokazania użytkownikowi. Szczegóły lecą dodatkowo do pliku,
     * bo stos ze zminifikowanego WhatsApp Weba i tak nic nie mówi w konsoli.
     */
    error(message: string, err?: unknown, context: ErrorContext = {}): void {
        const detail = err === undefined ? '' : `: ${describeError(err)}`;
        this.write('error', `${message}${detail}`);
        if (err !== undefined) this.toFile(err, { ...context, stage: context.stage ?? message });
    }

    /**
     * Błąd spodziewany i już obsłużony - do pliku, bez zaśmiecania konsoli.
     * Tędy idą na przykład nieudane próby getChat() przy identyfikatorach @lid.
     */
    quiet(err: unknown, context: ErrorContext = {}): void {
        this.debug(`[cicho] ${context.stage ?? 'błąd'}: ${describeError(err)}`);
        this.toFile(err, context);
    }

    private toFile(err: unknown, context: ErrorContext): void {
        if (!this.errorFile) return;
        try {
            const entry = {
                czas: new Date().toISOString(),
                etap: context.stage ?? null,
                blad: describeError(err),
                stos: stackOf(err),
                czat: context.chat ?? null,
                wiadomosc: context.messageId ?? null,
                typ: context.messageType ?? null,
            };

            let existing: unknown[] = [];
            if (fs.existsSync(this.errorFile)) {
                try {
                    const parsed: unknown = JSON.parse(fs.readFileSync(this.errorFile, 'utf8'));
                    if (Array.isArray(parsed)) existing = parsed;
                } catch {
                    // Uszkodzony plik zaczynamy od nowa - to tylko diagnostyka.
                }
            }
            existing.push(entry);

            fs.mkdirSync(path.dirname(this.errorFile), { recursive: true });
            fs.writeFileSync(
                this.errorFile,
                JSON.stringify(existing.slice(-ERROR_FILE_LIMIT), null, 2),
                'utf8',
            );
        } catch {
            // Zapis diagnostyki nie ma prawa wywrócić programu.
        }
    }
}

/**
 * Czytelny opis błędu. WhatsApp Web rzuca obiektami ze zminifikowaną nazwą
 * klasy ("r") i pustą treścią - samo err.message daje wtedy pustą linię,
 * więc dokładamy nazwę i, gdy i tego brak, sam kształt obiektu.
 */
export function describeError(err: unknown): string {
    if (err === null || err === undefined) return '(bez treści)';
    if (typeof err === 'string') return err;

    if (err instanceof Error || (typeof err === 'object' && 'message' in err)) {
        const asError = err as { name?: string; message?: string };
        const name = asError.name && asError.name !== 'Error' ? `${asError.name}: ` : '';
        const message = asError.message?.trim();
        if (message) return `${name}${message}`;
        if (name) return name.replace(/: $/, ' (błąd bez treści)');
    }

    try {
        return JSON.stringify(err) ?? String(err);
    } catch {
        return String(err);
    }
}

function stackOf(err: unknown): string | null {
    if (err instanceof Error && typeof err.stack === 'string') {
        return err.stack.split('\n').slice(0, 6).map((line) => line.trim()).join(' | ');
    }
    return null;
}

/** Jeden dziennik na cały program - moduły po prostu go importują. */
export const log = new Log();
