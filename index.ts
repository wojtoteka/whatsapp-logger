// WhatsApp Logger - punkt startowy.
//
//   npm start                     zbuduj i uruchom
//   npm start -- --sprawdz        pokaż wczytane ustawienia i zakończ
//   npm start -- --sprawdz-media  sprawdź, dlaczego nie idą pliki, i zakończ
//
// Przy pierwszym uruchomieniu w terminalu pojawi się kod QR. Zeskanuj go
// w telefonie: WhatsApp → Urządzenia połączone → Połącz urządzenie.

import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { Archive } from './src/archive';
import type { BackfillStats } from './src/archive';
import { checkArchive } from './src/archiveCheck';
import { checkMedia } from './src/mediaCheck';
import { loadConfig } from './src/config';
import { Database } from './src/db';
import { manageUsers } from './src/uzytkownicy';
import type { Config } from './src/config';
import { log } from './src/log';
import { statusLine, unlock } from './src/lockedChats';
import type { UnlockResult } from './src/lockedChats';
import { Notifier } from './src/notify';
import { runRetention } from './src/retention';
import { EXIT_AUTH_FAILURE, EXIT_RESTART, shouldRelinkWithoutRestart } from './src/restart';
import { TauService } from './src/tauService';
import type { WaClient, WaMessage } from './src/types';
import { ensureDirSync, formatHours } from './src/util';
import { createClient, healthLine, waitForContacts } from './src/waClient';

/** Katalog programu - ścieżki z .env liczą się względem niego. */
const ROOT_DIR = path.resolve(__dirname, '..');

/** Pod tą nazwą launcher przekazuje swój PID - patrz scripts/uruchom.ts. */
const PARENT_PID_ENV = 'WA_LOGGER_PARENT_PID';

/** Jak często sprawdzamy, czy launcher jeszcze żyje. */
const PARENT_CHECK_MS = 10_000;

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

    if (process.argv.includes('--sprawdz-archiwum')) {
        const result = await checkArchive(config.logsDir);
        log.blank();
        for (const issue of result.issues) {
            const line = `[${issue.file}] ${issue.message}`;
            if (issue.level === 'error') log.error(line);
            else log.warn(line);
        }
        log.info(
            `Archiwum: ${result.chats} czatów, ${result.batches} zamkniętych partii, ` +
                `${result.messages} wiadomości, błędy ${result.errors}, ostrzeżenia ${result.warnings}.`,
        );
        process.exitCode = result.errors > 0 ? 1 : 0;
        return;
    }

    if (process.argv.includes('--sprawdz') || process.argv.includes('--check')) {
        printConfig(config, envFileFound);
        return;
    }

    // Diagnoza pobierania plików. Wymaga żywej sesji, więc stoi osobno od
    // --sprawdz-archiwum, które czyta same pliki na dysku.
    if (process.argv.includes('--sprawdz-media')) {
        await runMediaCheck(config);
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

    const backfillAll =
        process.argv.includes('--nadrob-wszystko') || process.argv.includes('--backfill-all');

    const db = new Database(config);
    if (config.dbEnabled) {
        const result = await db.connect();
        log.info(result.message);
    }

    const notifier = new Notifier(config);
    const client = createClient(config, ROOT_DIR);
    const archive = new Archive(config, client, config.dbEnabled ? db : null);
    const tau = new TauService(config, client, archive);

    const runtime = new Runtime(config, client, archive, notifier, db, tau, backfillAll);
    runtime.wire();

    log.info('Łączę z WhatsApp Web...');
    await client.initialize();
}

/**
 * Diagnoza pobierania plików na żywej sesji WhatsApp Web.
 *
 * Notatka w archiwum mówi o jednym pliku. To polecenie odpowiada na pytanie,
 * którego z niej nie widać: czy WhatsApp nie chce oddać tego konkretnego
 * pliku, czy serwer w ogóle nie dosięga serwera plików. Pliki idą z innego
 * hosta niż sama strona, więc działający panel i wchodzące wiadomości niczego
 * o mediach nie dowodzą.
 */
async function runMediaCheck(config: Config): Promise<void> {
    const client = createClient(config, ROOT_DIR);

    client.on('qr', () => {
        log.error('Ta sesja nie jest sparowana. Uruchom najpierw logger i zeskanuj kod QR.');
    });

    const ready = new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve());
        client.on('auth_failure', (message) => reject(new Error(String(message))));
    });

    log.info('Łączę z WhatsApp Web...');
    try {
        await client.initialize();
        await ready;

        log.info('Sprawdzam drogę pobierania plików - to potrwa do minuty.');
        const result = await checkMedia(client, config.logsDir);

        log.blank();
        log.info(`Sieć: ${result.siec}`);
        log.info(`Wnętrze WhatsApp Weba: ${result.wnetrze}`);
        log.info(`W kolejce ponowień: ${String(result.wKolejce)}.`);

        for (const probe of result.probki) {
            log.blank();
            log.info(`[${probe.źródło}] ${probe.typ} - ${probe.id}`);
            log.info(`  model:      ${probe.model}`);
            log.info(`  biblioteka: ${probe.biblioteka}`);
            log.info(`  store:      ${probe.store}`);
        }

        if (result.uwagi.length > 0) log.blank();
        for (const uwaga of result.uwagi) log.warn(uwaga);
    } finally {
        await client.destroy().catch(() => undefined);
    }
}

/**
 * Wszystko, co żyje przez cały czas działania programu: zdarzenia klienta,
 * timery przeglądów i porządne zamknięcie.
 */
class Runtime {
    private retentionTimer: NodeJS.Timeout | null = null;
    private sweepTimer: NodeJS.Timeout | null = null;
    private incrementalTimer: NodeJS.Timeout | null = null;
    private incrementalRunning = false;
    private incrementalFailures = 0;
    private incrementalRetryAt = 0;
    private readyFallbackTimer: NodeJS.Timeout | null = null;
    /** Zegar pilnujący, czy launcher jeszcze żyje - patrz watchParent(). */
    private parentWatchTimer: NodeJS.Timeout | null = null;
    private readyStarted = false;
    /** Porządki po LOGOUT, na które musi zaczekać ponowne zdarzenie ready. */
    private relinkPreparation: Promise<void> | null = null;
    private shuttingDown = false;
    /** Ostatni wynik odsłaniania zabezpieczonych czatów. */
    private locked: UnlockResult | null = null;

    constructor(
        private readonly config: Config,
        private readonly client: WaClient,
        private readonly archive: Archive,
        private readonly notifier: Notifier,
        private readonly db: Database,
        private readonly tau: TauService,
        /** Jednorazowy tryb, który może założyć foldery dla wszystkich czatów. */
        private readonly backfillAll: boolean,
    ) {}

    wire(): void {
        this.wireAuth();
        this.wireMessages();
        this.wireShutdown();
    }

    // -- Logowanie i połączenie -------------------------------------------

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
            this.scheduleReadyFallback();
        });

        this.client.on('auth_failure', (message) => {
            log.endProgress();
            log.error(`Uwierzytelnienie odrzucone: ${message}`);
            log.error('Usuń folder .wwebjs_auth i uruchom program ponownie, żeby zeskanować nowy kod QR.');
            void this.notifier.authFailure(message).finally(() => process.exit(EXIT_AUTH_FAILURE));
        });

        this.client.on('disconnected', (reason) => {
            log.endProgress();
            const text = String(reason);
            log.warn(`Rozłączono z WhatsAppem: ${text}`);
            if (shouldRelinkWithoutRestart(text)) {
                this.beginRelinkAfterLogout(text);
            } else {
                void this.restartAfterDisconnect(text);
            }
        });

        this.client.on('ready', () => {
            this.clearReadyFallback();
            void this.onReady();
        });
    }

    /**
     * W niektórych wydaniach WhatsApp Web biblioteka potwierdza autoryzację,
     * ale nie emituje później ready, mimo że Store już działa. Nie czekamy
     * wtedy bez końca: po chwili uruchamiamy tę samą kontrolowaną ścieżkę.
     */
    private scheduleReadyFallback(): void {
        if (this.readyStarted || this.readyFallbackTimer || this.shuttingDown) return;

        log.info('Czekam na gotowość danych WhatsApp Web...');
        this.readyFallbackTimer = setTimeout(() => {
            this.readyFallbackTimer = null;
            if (this.readyStarted || this.shuttingDown) return;
            log.warn('WhatsApp Web nie zgłosił gotowości - próbuję kontynuować awaryjnie.');
            void this.onReady();
        }, 15_000);
        this.readyFallbackTimer.unref?.();
    }

    private clearReadyFallback(): void {
        if (!this.readyFallbackTimer) return;
        clearTimeout(this.readyFallbackTimer);
        this.readyFallbackTimer = null;
    }

    /**
     * Biblioteka woła "ready", gdy tylko wstrzyknie window.Store - dane
     * WhatsAppa mogą być wtedy jeszcze w drodze. Dlatego zanim cokolwiek
     * zrobimy, czekamy na książkę adresową.
     */
    private async onReady(): Promise<void> {
        if (this.shuttingDown || this.readyStarted) return;
        this.readyStarted = true;
        this.clearReadyFallback();

        // Przy LOGOUT biblioteka emituje disconnected zanim skończy usuwać
        // LocalAuth i przygotuje nową sesję. Nie uruchamiamy zadań archiwum
        // ani ?tau, dopóki poprzednia sesja nie została spokojnie domknięta.
        if (this.relinkPreparation) {
            await this.relinkPreparation;
            this.relinkPreparation = null;
            if (this.shuttingDown) return;
        }

        const health = await waitForContacts(this.client, {
            onProgress: (state) => {
                if (state.contacts > 0) {
                    log.progress(`Synchronizacja: ${state.contacts} kontaktów...`);
                } else if (state.store) {
                    log.progress(`Synchronizacja: czekam na kontakty (${state.chats} czatów)...`);
                } else {
                    log.progress('Synchronizacja: czekam na dane WhatsApp Web...');
                }
            },
        });
        log.endProgress();
        // Pełne liczniki niczego nie nadrabiają ani nie mówią o archiwum.
        // Zostawiamy tylko komunikaty diagnostyczne dla niepełnych danych.
        if (!health.complete || health.contacts === 0) log.info(healthLine(health));

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

        // Pełną historię pobiera wyłącznie jawne --nadrob-wszystko. Zwykły
        // start - także pierwszy, na pustym archiwum - dotyka tylko rozmów,
        // które mają już swój folder w logs/. Wcześniej puste archiwum samo
        // włączało tryb pełny: jedno uruchomienie zakładało foldery całej
        // książce adresowej i mieliło setki czatów bez historii.
        if (!this.backfillAll && this.archive.isEmpty) {
            log.info(
                'Archiwum jest puste - zwykły start nie ma czego nadrabiać. ' +
                    'Całą dostępną historię pobierze "npm start -- --nadrob-wszystko".',
            );
        }

        const backfill = await this.backfillMessages(this.backfillAll);

        if (this.backfillAll) {
            const failed =
                backfill?.listingFailed === true ||
                backfill?.complete === false ||
                (backfill?.failedChats ?? 0) > 0;
            if (failed) {
                log.error('Nadrabianie zakończone z błędami - sprawdź podsumowanie powyżej.');
            } else {
                log.info('✓ Nadrabianie wszystkich dostępnych czatów zakończone.');
            }
            await this.shutdown('polecenie --nadrob-wszystko', failed ? 1 : 0);
            return;
        }

        await this.tau.start();

        log.info('✓ Archiwizuję wiadomości. Zatrzymanie: Ctrl+C.');
        log.blank();

        void this.notifier.ready();
        this.startRetention();
        this.startSweep();
        this.startIncrementalSync();
    }

    /** Dobiera wiadomości z czasu, gdy proces nie działał. */
    private async backfillMessages(includeNewChats: boolean): Promise<BackfillStats | null> {
        if (!includeNewChats && this.config.backfillMessagesPerChat <= 0) {
            log.info('Nadrabianie wiadomości: wyłączone.');
            return null;
        }

        log.info(
            includeNewChats
                ? 'Pełne nadrabianie: pobieram wszystkie rozmowy i całą historię dostępną w WhatsApp Web...'
                : `Nadrabianie wiadomości: sprawdzam do ${this.config.backfillMessagesPerChat} ` +
                  'ostatnich wiadomości w rozmowach, które mają już folder w archiwum...',
        );
        const stats = await this.archive.backfillRecent(
            Math.max(this.config.backfillMessagesPerChat, 250),
            {
                includeNewChats,
                fullHistory: includeNewChats,
                ...(includeNewChats
                    ? {
                          onProgress: (progress) => {
                              const chat = progress.chat ? ` - ${consoleLabel(progress.chat)}` : '';
                              log.progress(
                                  `Nadrabianie ${String(progress.percent).padStart(3, ' ')}%: ` +
                                      `${progress.detail}${chat}`,
                              );
                          },
                      }
                    : {}),
            },
        );
        if (includeNewChats) log.endProgress();
        const failed = stats.failedChats > 0 ? `, błędów czatów ${stats.failedChats}` : '';
        const newChats =
            stats.skippedNewChats > 0
                ? `, pominiętych czatów bez folderu ${stats.skippedNewChats}`
                : '';
        const created = stats.newChats > 0 ? `, nowych rozmów ${stats.newChats}` : '';
        const updated = stats.updated > 0 ? `, zaktualizowanych ${stats.updated}` : '';
        const completeness = stats.complete ? '' : ', zakres niepełny';
        log.info(
            `Nadrabianie wiadomości: dopisano ${stats.saved}, ` +
                `już zapisanych ${stats.skipped}, przejrzano ${stats.scanned} ` +
                `w ${stats.chats} czatach${created}${updated}${newChats}${failed}${completeness}.`,
        );
        return stats;
    }

    /** Lekka kontrola znanych czatów, bez równoległych przebiegów. */
    private startIncrementalSync(): void {
        if (this.incrementalTimer || this.config.syncIntervalMinutes <= 0) {
            if (this.config.syncIntervalMinutes <= 0) log.info('Synchronizacja okresowa: wyłączona.');
            return;
        }

        log.info(`Synchronizacja okresowa: co ${this.config.syncIntervalMinutes} min.`);
        this.incrementalTimer = setInterval(
            () => void this.runIncrementalSync(),
            this.config.syncIntervalMinutes * 60 * 1000,
        );
        this.incrementalTimer.unref?.();
    }

    private async runIncrementalSync(): Promise<void> {
        if (
            this.incrementalRunning ||
            this.shuttingDown ||
            Date.now() < this.incrementalRetryAt
        ) {
            return;
        }
        this.incrementalRunning = true;
        try {
            this.archive.refreshAfterSync();
            const stats = await this.archive.backfillRecent();
            if (stats.saved > 0 || stats.updated > 0) {
                log.info(
                    `Synchronizacja okresowa: nowych ${stats.saved}, zaktualizowanych ${stats.updated}.`,
                );
            }
            if (stats.complete) {
                this.incrementalFailures = 0;
                this.incrementalRetryAt = 0;
            } else {
                this.scheduleIncrementalBackoff();
            }
        } catch (err) {
            log.error('Błąd synchronizacji okresowej', err, { stage: 'synchronizacja okresowa' });
            this.scheduleIncrementalBackoff();
        } finally {
            this.incrementalRunning = false;
        }
    }

    private scheduleIncrementalBackoff(): void {
        this.incrementalFailures++;
        const base = this.config.syncIntervalMinutes * 60 * 1000;
        const delay = Math.min(base * 2 ** this.incrementalFailures, 6 * 60 * 60 * 1000);
        this.incrementalRetryAt = Date.now() + delay;
        log.warn(
            `Synchronizacja okresowa: kolejna próba najwcześniej za ${Math.ceil(delay / 60000)} min.`,
        );
    }

    /** Kończy proces kodem, który nadzorca rozpoznaje jako awarię przejściową. */
    private async restartAfterDisconnect(reason: string): Promise<void> {
        try {
            await this.notifier.disconnected(reason);
        } finally {
            await this.shutdown('rozłączenie', EXIT_RESTART);
        }
    }

    /**
     * Utrata sparowania nie jest zwykłą awarią połączenia. whatsapp-web.js
     * pozostawia tę samą stronę otwartą, kasuje LocalAuth i za chwilę emituje
     * `qr`. Nie wolno wtedy wywołać destroy(), bo przerwiemy ten mechanizm.
     */
    private beginRelinkAfterLogout(reason: string): void {
        if (this.relinkPreparation || this.shuttingDown) return;

        this.readyStarted = false;
        this.locked = null;
        this.clearReadyFallback();
        this.pauseOperationalTimers();
        this.incrementalFailures = 0;
        this.incrementalRetryAt = 0;

        log.info('Sesja została wylogowana. Czekam na nowy kod QR w tym terminalu...');
        this.relinkPreparation = this.prepareForRelink(reason);
    }

    private async prepareForRelink(reason: string): Promise<void> {
        const tasks = [
            { stage: 'powiadomienie Discord', promise: this.notifier.disconnected(reason) },
            { stage: 'zatrzymanie tau', promise: this.tau.stop() },
            { stage: 'zapis archiwum', promise: this.archive.flushAll() },
        ] as const;
        const results = await Promise.allSettled(tasks.map((task) => task.promise));
        let complete = true;
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') return;
            complete = false;
            // Błąd dodatku lub zapisu nie może zamknąć strony przed QR.
            log.error('Błąd przygotowania ponownego parowania', result.reason, {
                stage: tasks[index]!.stage,
            });
        });
        if (complete) {
            log.info('✓ Dane sprzed wylogowania zapisane. Logger czeka na ponowne sparowanie.');
        } else {
            log.warn('Logger czeka na ponowne sparowanie, ale część porządków zakończyła się błędem.');
        }
    }

    private pauseOperationalTimers(): void {
        if (this.retentionTimer) clearInterval(this.retentionTimer);
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        if (this.incrementalTimer) clearInterval(this.incrementalTimer);
        this.retentionTimer = null;
        this.sweepTimer = null;
        this.incrementalTimer = null;
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
        if (Array.isArray(this.locked.lockedChatIds)) {
            this.archive.setLockedChatIds(this.locked.lockedChatIds);
        }

        // Przy ponowieniu odzywamy się tylko wtedy, gdy coś się zmieniło.
        if (previous === undefined || previous !== this.locked.status) {
            log.info(statusLine(this.locked));
        }
    }

    // -- Wiadomości -------------------------------------------------------

    private wireMessages(): void {
        // Odebrane
        this.client.on('message', (message) => {
            void this.handleIncoming(message as WaMessage).catch((error: unknown) => {
                log.error('Błąd dodatkowej obsługi odebranej wiadomości', error, {
                    stage: 'message extras',
                });
            });
        });

        // Wysłane przez Ciebie. To zdarzenie leci również dla odebranych,
        // stąd filtr fromMe - inaczej każda wiadomość byłaby zapisana dwa razy.
        this.client.on('message_create', (message) => {
            if (message.fromMe) {
                void this.handleOutgoing(message as WaMessage).catch((error: unknown) => {
                    log.error('Błąd dodatkowej obsługi wysłanej wiadomości', error, {
                        stage: 'message extras',
                    });
                });
            }
        });

        // Skasowane "dla wszystkich" - "before" to jeszcze pełna treść.
        this.client.on('message_revoke_everyone', (after, before) => {
            // W 1.34.6 parametr "before" może być undefined. "after" nadal
            // niesie identyfikator wiadomości i wystarcza do oznaczenia rekordu.
            void this.archive.markDeleted((before ?? after) as WaMessage);
        });

        // Skasowane "dla mnie".
        this.client.on('message_revoke_me', (message) => {
            void this.archive.markDeleted(message as WaMessage);
        });

        // Doręczenie i odczytanie własnych wiadomości. WhatsApp podaje samą
        // zmianę stanu, bez godziny - dlatego liczy się chwila, w której to
        // zdarzenie do nas dotarło, i tylko wtedy, gdy program pracuje.
        this.client.on('message_ack', (message, ack) => {
            void this.archive.markAck(message as WaMessage, Number(ack)).catch((error: unknown) => {
                log.quiet(error, { stage: 'potwierdzenie odczytu' });
            });
        });
    }

    private async handleIncoming(message: WaMessage): Promise<void> {
        await this.archive.save(message);
        await this.tau.acceptIncoming(message);
    }

    private async handleOutgoing(message: WaMessage): Promise<void> {
        // Polecenie jest analizowane dopiero po trwałym wejściu do kolejki
        // archiwum. Awaria AI nie może zrobić dziury w podstawowym zapisie.
        await this.archive.save(message);
        await this.tau.acceptOutgoing(message);
    }

    // -- Przeglądy cykliczne ----------------------------------------------

    /** Relacje i zaległe zdjęcia profilowe. */
    private startSweep(): void {
        if (this.sweepTimer) return;

        const what: string[] = [];
        if (this.config.saveStatuses) what.push('relacje');
        if (this.config.saveProfilePics) {
            what.push(`zdjęcia profilowe co ${this.config.avatarRefreshDays} dni`);
        }
        // Zaległe pliki nie są opcją do wyłączenia - są naprawą tego, co już
        // trafiło do archiwum z notatką zamiast zdjęcia. Wcześniej wisiały pod
        // tym samym warunkiem co relacje i awatary, więc wyłączenie obu
        // zatrzymywało również kolejkę ponowień i notatka zostawała na zawsze.
        what.push('zaległe pliki');

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
        // Dopóki nie ma rozstrzygnięcia, próbujemy dalej, żeby kolejne
        // nadrabianie mogło zobaczyć również ich wcześniejszą historię.
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

        // Pliki, których WhatsApp nie oddał przy zapisie. Telefon zwykle
        // wysyła je ponownie w ciągu kilku godzin, więc notatka "nie udało
        // się pobrać pliku" nie musi zostać w archiwum na zawsze.
        try {
            const stats = await this.archive.retryFailedMedia();
            if (stats.recovered > 0) {
                log.info(
                    `Zaległe pliki: odzyskano ${stats.recovered} z ${stats.tried}` +
                        (stats.waiting > 0 ? `, czeka jeszcze ${stats.waiting}` : '') +
                        '.',
                );
            }
        } catch (err) {
            log.error('Błąd ponownego pobierania plików', err, { stage: 'zaległe pliki' });
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

    // -- Zamykanie --------------------------------------------------------

    private wireShutdown(): void {
        const stop = (signal: string): void => {
            void this.shutdown(signal);
        };
        process.on('SIGINT', () => stop('SIGINT'));
        process.on('SIGTERM', () => stop('SIGTERM'));
        // SIGHUP przychodzi, gdy znika terminal - czyli przy każdym zamknięciu
        // połączenia SSH. Bez tej obsługi Node kończył proces na miejscu,
        // zostawiając niedopisane wiadomości i otwartego Chromium.
        process.on('SIGHUP', () => stop('SIGHUP'));

        this.watchParent();

        process.on('unhandledRejection', (reason) => {
            log.error('Nieobsłużony błąd w tle', reason, { stage: 'unhandledRejection' });
            void this.shutdown('unhandledRejection', EXIT_RESTART);
        });
        process.on('uncaughtException', (err) => {
            log.error('Nieoczekiwany błąd', err, { stage: 'uncaughtException' });
            void this.shutdown('uncaughtException', EXIT_RESTART);
        });
    }

    /**
     * Pilnuje, czy launcher jeszcze żyje.
     *
     * Sygnały załatwiają zwykłe zamykanie, ale nie każde. Launcher zabity
     * twardo (SIGKILL, zapchana pamięć) nie zdąży już nikomu nic powiedzieć,
     * a logger zostaje wtedy sierotą pod PID 1 - razem z Chromium, które
     * potrafi ciągnąć procesor, dopóki ktoś ręcznie go nie znajdzie i nie ubije.
     *
     * Sprawdzamy konkretny PID przekazany w zmiennej środowiskowej, a nie samo
     * "czy rodzic to init". Uruchomienie loggera wprost - z systemd albo z ręki -
     * tej zmiennej nie ma i wtedy nic tu nie pilnujemy.
     */
    private watchParent(): void {
        const expected = Number(process.env[PARENT_PID_ENV]);
        if (!Number.isInteger(expected) || expected <= 1) return;

        this.parentWatchTimer = setInterval(() => {
            if (this.shuttingDown || process.ppid === expected) return;
            log.warn('Program nadrzędny zniknął - zamykam się razem z nim.');
            void this.shutdown('zniknął launcher');
        }, PARENT_CHECK_MS);
        this.parentWatchTimer.unref?.();
    }

    private async shutdown(signal: string, exitCode = 0): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        log.endProgress();
        log.blank();
        log.info(`Zatrzymuję (${signal}). Zapisuję to, co czeka w pamięci...`);

        this.pauseOperationalTimers();
        this.clearReadyFallback();
        if (this.parentWatchTimer) {
            clearInterval(this.parentWatchTimer);
            this.parentWatchTimer = null;
        }

        try {
            await this.tau.stop();
        } catch (err) {
            log.quiet(err, { stage: 'zamykanie tau' });
        }

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
        try {
            await this.db.close();
        } catch (err) {
            log.quiet(err, { stage: 'zamykanie bazy' });
        }
        process.exit(exitCode);
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
    log.info(`  Nadrabianie na czat      ${config.backfillMessagesPerChat}`);
    log.info(`  Synchronizacja okresowa  ${config.syncIntervalMinutes > 0 ? `co ${config.syncIntervalMinutes} min` : 'wyłączona'}`);
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
    log.info(
        `  ?tau                     ${
            config.tauEnabled
                ? `tak, provider +${config.tauProviderNumber}, timeout ${config.tauTimeoutSeconds} s`
                : 'wyłączone'
        }`,
    );
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

/** Nazwa z WhatsAppa nie może rozbić jednej linii postępu ani wstrzyknąć ANSI. */
function consoleLabel(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 70);
}

main().catch((err: unknown) => {
    log.error('Program nie wystartował', err, { stage: 'start' });
    process.exit(1);
});
