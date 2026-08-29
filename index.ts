// WhatsApp Logger - punkt startowy.
//
//   npm start              zbuduj i uruchom
//   npm start -- --sprawdz pokaż wczytane ustawienia i zakończ
//
// Przy pierwszym uruchomieniu w terminalu pojawi się kod QR. Zeskanuj go
// w telefonie: WhatsApp → Urządzenia połączone → Połącz urządzenie.

import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { Archive } from './src/archive';
import { loadConfig } from './src/config';
import { Database } from './src/db';
import { manageUsers } from './src/uzytkownicy';
import type { Config } from './src/config';
import { log } from './src/log';
import { statusLine, unlock } from './src/lockedChats';
import type { UnlockResult } from './src/lockedChats';
import { Notifier } from './src/notify';
import { runRetention } from './src/retention';
import type { WaClient, WaMessage } from './src/types';
import { ensureDirSync, formatHours } from './src/util';
import { createClient, healthLine, waitForContacts } from './src/waClient';

/** Katalog programu - ścieżki z .env liczą się względem niego. */
const ROOT_DIR = path.resolve(__dirname, '..');

async function main(): Promise<void> {
    const { config, warnings, envFileFound } = loadConfig(ROOT_DIR);

    log.setLevel(config.logLevel);
    ensureDirSync(config.logsDir);
    log.setErrorFile(config.logsDir);

    log.info('WhatsApp Logger');

    if (!envFileFound) {
        log.warn('Nie ma pliku .env - lecę na ustawieniach domyślnych.');
        log.warn('Skopiuj .env.example do .env, żeby cokolwiek zmienić.');
    }
    for (const warning of warnings) log.warn(`Ustawienia: ${warning}`);

    if (process.argv.includes('--sprawdz') || process.argv.includes('--check')) {
        printConfig(config, envFileFound);
        return;
    }

    // Konto do panelu. Osobne polecenie, żeby nie mieszać zakładania
    // użytkowników z archiwizacją.
    if (process.argv.includes('--uzytkownik') || process.argv.includes('--user')) {
        process.exitCode = await manageUsers(config, process.argv);
        return;
    }

    // Sprawdzenie samej bazy: łączy się, zakłada tabele i kończy. Przydaje
    // się przy pierwszym uruchomieniu na serwerze, bez czekania na QR.
    if (process.argv.includes('--baza') || process.argv.includes('--db')) {
        const probe = new Database({ ...config, dbEnabled: true });
        const result = await probe.connect();
        log.info(result.message);
        if (result.ok) {
            log.info('Tabele są na miejscu (chats, messages, panel_users).');
            const users = await probe.listUsers();
            log.info(
                users.length > 0
                    ? `Konta do panelu: ${users.join(', ')}`
                    : 'Nie ma jeszcze konta do panelu - załóż je: npm start -- --uzytkownik',
            );
        }
        await probe.close();
        process.exitCode = result.ok ? 0 : 1;
        return;
    }

    const db = new Database(config);
    if (config.dbEnabled) {
        const result = await db.connect();
        log.info(result.message);
    }

    const notifier = new Notifier(config);
    const client = createClient(config, ROOT_DIR);
    const archive = new Archive(config, client, config.dbEnabled ? db : null);

    const runtime = new Runtime(config, client, archive, notifier, db);
    runtime.wire();

    log.info('Łączę z WhatsApp Web...');
    await client.initialize();
}

/**
 * Wszystko, co żyje przez cały czas działania programu: zdarzenia klienta,
 * timery przeglądów i porządne zamknięcie.
 */
class Runtime {
    private retentionTimer: NodeJS.Timeout | null = null;
    private sweepTimer: NodeJS.Timeout | null = null;
    private shuttingDown = false;
    /** Ostatni wynik odsłaniania zabezpieczonych czatów. */
    private locked: UnlockResult | null = null;

    constructor(
        private readonly config: Config,
        private readonly client: WaClient,
        private readonly archive: Archive,
        private readonly notifier: Notifier,
        private readonly db: Database,
    ) {}

    wire(): void {
        this.wireAuth();
        this.wireMessages();
        this.wireShutdown();
    }

    // ── Logowanie i połączenie ───────────────────────────────────────────

    private wireAuth(): void {
        this.client.on('qr', (qr) => {
            log.endProgress();
            log.blank();
            log.info('╔══════════════════════════════════════════╗');
            log.info('║  Zeskanuj kod QR w aplikacji WhatsApp    ║');
            log.info('║  Ustawienia > Urządzenia połączone       ║');
            log.info('╚══════════════════════════════════════════╝');
            qrcode.generate(qr, { small: true });
            void this.notifier.qrRequired();
        });

        this.client.on('loading_screen', (percent, message) => {
            log.progress(`WhatsApp wczytuje dane: ${percent}% ${message}`.trimEnd());
        });

        // WhatsApp Web potrafi wysłać to zdarzenie kilka razy pod rząd,
        // zwłaszcza tuż po sparowaniu, gdy strona się przeładowuje.
        this.client.on('authenticated', () => {
            log.endProgress();
            log.once('auth', '✓ Uwierzytelnienie przyjęte.', 'info');
        });

        this.client.on('auth_failure', (message) => {
            log.endProgress();
            log.error(`Uwierzytelnienie odrzucone: ${message}`);
            log.error('Usuń folder .wwebjs_auth i uruchom program ponownie, żeby zeskanować nowy kod QR.');
            void this.notifier.authFailure(message).finally(() => process.exit(1));
        });

        this.client.on('disconnected', (reason) => {
            log.endProgress();
            log.warn(`Rozłączono z WhatsAppem: ${String(reason)}`);
            void this.notifier.disconnected(String(reason));
        });

        this.client.on('ready', () => {
            void this.onReady();
        });
    }

    /**
     * Biblioteka woła "ready", gdy tylko wstrzyknie window.Store - dane
     * WhatsAppa mogą być wtedy jeszcze w drodze. Dlatego zanim cokolwiek
     * zrobimy, czekamy na książkę adresową.
     */
    private async onReady(): Promise<void> {
        const health = await waitForContacts(this.client, {
            onProgress: (state) => {
                if (state.contacts > 0) log.progress(`Synchronizacja: ${state.contacts} kontaktów...`);
            },
        });
        log.endProgress();
        log.info(healthLine(health));

        // Dopiero teraz WhatsApp wie, kto jest kim - puste odpowiedzi
        // sprzed synchronizacji nie mają prawa zostać w pamięci.
        this.archive.refreshAfterSync();

        // Nie rozgłaszamy się jako "dostępny" - logger tylko czyta.
        try {
            await this.client.sendPresenceUnavailable();
        } catch (err) {
            log.quiet(err, { stage: 'sendPresenceUnavailable' });
        }

        await this.tryUnlockLockedChats();

        log.info('✓ Archiwizuję wiadomości. Zatrzymanie: Ctrl+C.');
        log.blank();

        void this.notifier.ready();
        this.startRetention();
        this.startSweep();
    }

    /**
     * Odsłania zabezpieczone czaty. Gdy strona jeszcze nie była gotowa,
     * próbujemy ponownie przy każdym przeglądzie - poprzednio jedna nieudana
     * próba przy starcie oznaczała, że przez całą sesję zostawały zamknięte.
     */
    private async tryUnlockLockedChats(): Promise<void> {
        if (isFinalUnlock(this.locked)) return;

        const previous = this.locked?.status;
        this.locked = await unlock(this.client, this.config.lockedChatPassword);

        // Przy ponowieniu odzywamy się tylko wtedy, gdy coś się zmieniło.
        if (previous === undefined || previous !== this.locked.status) {
            log.info(statusLine(this.locked));
        }
    }

    // ── Wiadomości ───────────────────────────────────────────────────────

    private wireMessages(): void {
        // Odebrane
        this.client.on('message', (message) => {
            void this.archive.save(message as WaMessage);
        });

        // Wysłane przez Ciebie. To zdarzenie leci również dla odebranych,
        // stąd filtr fromMe - inaczej każda wiadomość byłaby zapisana dwa razy.
        this.client.on('message_create', (message) => {
            if (message.fromMe) void this.archive.save(message as WaMessage);
        });

        // Skasowane "dla wszystkich" - "before" to jeszcze pełna treść.
        this.client.on('message_revoke_everyone', (_after, before) => {
            if (before) void this.archive.markDeleted(before as WaMessage);
        });

        // Skasowane "dla mnie".
        this.client.on('message_revoke_me', (message) => {
            void this.archive.markDeleted(message as WaMessage);
        });
    }

    // ── Przeglądy cykliczne ──────────────────────────────────────────────

    /** Relacje i zaległe zdjęcia profilowe. */
    private startSweep(): void {
        if (this.sweepTimer) return;

        const what: string[] = [];
        if (this.config.saveStatuses) what.push('relacje');
        if (this.config.saveProfilePics) {
            what.push(`zdjęcia profilowe co ${this.config.avatarRefreshDays} dni`);
        }
        if (what.length === 0) {
            log.info('Przegląd: wyłączony.');
            return;
        }

        log.info(`Przegląd co ${formatHours(this.config.sweepCheckHours)}: ${what.join(', ')}.`);

        void this.sweep();
        this.sweepTimer = setInterval(
            () => void this.sweep(),
            this.config.sweepCheckHours * 60 * 60 * 1000,
        );
        this.sweepTimer.unref?.();
    }

    private async sweep(): Promise<void> {
        // Zabezpieczone czaty mogły nie zdążyć się otworzyć przy starcie.
        // Dopóki nie ma rozstrzygnięcia, próbujemy dalej - inaczej ich
        // wiadomości nie trafiłyby do archiwum przez całe uruchomienie.
        await this.tryUnlockLockedChats();

        // Relacje najpierw - żyją dobę, więc każda minuta zwłoki to ryzyko,
        // że przepadną. Zdjęcia profilowe nigdzie się nie spieszą.
        try {
            const stats = await this.archive.sweepStatuses();
            if (stats.saved > 0) log.info(`Relacje: dopisano ${stats.saved}.`);
        } catch (err) {
            log.error('Błąd przeglądu relacji', err, { stage: 'przegląd relacji' });
        }

        try {
            const stats = await this.archive.refreshAvatars();
            if (stats.changed > 0) log.info(`Zdjęcia profilowe: nowych wersji ${stats.changed}.`);
        } catch (err) {
            log.error('Błąd odświeżania zdjęć profilowych', err, { stage: 'przegląd zdjęć' });
        }
    }

    /** Kasowanie starych plików i oczekujących wiadomości. */
    private startRetention(): void {
        if (this.retentionTimer) return;

        if (!this.config.retentionEnabled || this.config.retentionDays <= 0) {
            log.info('Kasowanie starych wiadomości: wyłączone.');
            return;
        }

        log.info(
            `Kasowanie starych wiadomości: po ${this.config.retentionDays} dniach, ` +
                `sprawdzam co ${formatHours(this.config.retentionCheckHours)}.`,
        );

        void this.runRetention();
        this.retentionTimer = setInterval(
            () => void this.runRetention(),
            this.config.retentionCheckHours * 60 * 60 * 1000,
        );
        this.retentionTimer.unref?.();
    }

    private async runRetention(): Promise<void> {
        try {
            await runRetention(this.archive.logsDir, this.config.retentionDays);
            await this.archive.pruneOldPending(this.config.retentionDays);
        } catch (err) {
            log.error('Błąd kasowania starych plików', err, { stage: 'kasowanie' });
        }
    }

    // ── Zamykanie ────────────────────────────────────────────────────────

    private wireShutdown(): void {
        const stop = (signal: string): void => {
            void this.shutdown(signal);
        };
        process.on('SIGINT', () => stop('SIGINT'));
        process.on('SIGTERM', () => stop('SIGTERM'));

        process.on('unhandledRejection', (reason) => {
            log.error('Nieobsłużony błąd w tle', reason, { stage: 'unhandledRejection' });
        });
        process.on('uncaughtException', (err) => {
            log.error('Nieoczekiwany błąd', err, { stage: 'uncaughtException' });
        });
    }

    private async shutdown(signal: string): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        log.endProgress();
        log.blank();
        log.info(`Zatrzymuję (${signal}). Zapisuję to, co czeka w pamięci...`);

        if (this.retentionTimer) clearInterval(this.retentionTimer);
        if (this.sweepTimer) clearInterval(this.sweepTimer);

        try {
            await this.archive.flushAll();
            log.info('✓ Wszystko zapisane.');
        } catch (err) {
            log.error('Nie udało się zapisać wszystkiego', err, { stage: 'zamykanie' });
        }

        try {
            await this.client.destroy();
        } catch {
            // Przeglądarka mogła już zniknąć - nic nie szkodzi.
        }
        await this.db.close();
        process.exit(0);
    }
}

/** Wypisuje wczytane ustawienia. Sekrety pokazujemy tylko jako "ustawione". */
function printConfig(config: Config, envFileFound: boolean): void {
    const secret = (value: string): string => (value ? 'ustawione' : '(puste)');

    log.blank();
    log.info(`Plik .env: ${envFileFound ? 'wczytany' : 'BRAK, same wartości domyślne'}`);
    log.info('');
    log.info(`  Archiwum                 ${config.logsDir}`);
    log.info(`  Wiadomości na plik       ${config.messagesPerFile}`);
    log.info(`  Pobierane media          ${[...config.mediaTypes].join(', ') || '(żadne)'}`);
    log.info(`  Limit pliku              ${config.maxMediaSizeMb} MB`);
    log.info(`  Zdjęcia profilowe        ${config.saveProfilePics ? `tak, odświeżanie co ${config.avatarRefreshDays} dni` : 'nie'}`);
    log.info(`  Relacje                  ${config.saveStatuses ? `tak, przegląd co ${formatHours(config.sweepCheckHours)}` : 'nie'}`);
    log.info(
        `  Kasowanie starych        ${
            config.retentionEnabled && config.retentionDays > 0
                ? `po ${config.retentionDays} dniach, sprawdzanie co ${formatHours(config.retentionCheckHours)}`
                : 'wyłączone'
        }`,
    );
    log.info(`  Zapis stanu co           ${config.stateSaveIntervalMs} ms`);
    log.info(
        `  Baza danych              ${
            config.dbEnabled
                ? `${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbName}`
                : 'wyłączona'
        }`,
    );
    log.info(`  Przeglądarka             ${config.chromePath ?? '(wykrywana automatycznie)'}`);
    log.info(`  Okno przeglądarki        ${config.headless ? 'ukryte' : 'widoczne'}`);
    log.info(`  Poziom logów             ${config.logLevel}`);
    log.info('');
    log.info(`  Hasło zabezpieczonych czatów   ${secret(config.lockedChatPassword)}`);
    log.info(`  Hasło do bazy                  ${secret(config.dbPassword)}`);
    log.info(`  Webhook Discorda               ${secret(config.discordWebhookUrl)}`);
    log.info(`  Ping Discorda                  ${secret(config.discordPingUserId)}`);
    log.blank();
}

/**
 * Czy wynik jest ostateczny.
 *
 * "not_enabled" celowo nie jest na tej liście: WhatsApp potrafi tak
 * odpowiedzieć, zanim zsynchronizuje ustawienia blokady czatów. Przy
 * kolejnym przeglądzie pytamy jeszcze raz.
 */
function isFinalUnlock(result: UnlockResult | null): boolean {
    if (!result) return false;
    return ['disabled', 'granted', 'invalid_password', 'unsupported'].includes(result.status);
}

main().catch((err: unknown) => {
    log.error('Program nie wystartował', err, { stage: 'start' });
    process.exit(1);
});
