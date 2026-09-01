// Wspólna polityka kodów wyjścia i ponawiania procesu loggera.

/** Rozłączenie lub błąd przejściowy - nadzorca może uruchomić logger ponownie. */
export const EXIT_RESTART = 2;
/** Utrata autoryzacji wymaga działania człowieka, więc pętla restartów nie pomoże. */
export const EXIT_AUTH_FAILURE = 20;
/** Nikt nie zeskanował kodu QR. Restart wygenerowałby tylko kolejne kody. */
export const EXIT_QR_UNSCANNED = 21;

export const RESTART_WINDOW_MS = 15 * 60 * 1000;
export const RESTART_MAX_ATTEMPTS = 8;
const RESTART_BASE_DELAY_MS = 5000;
const RESTART_MAX_DELAY_MS = 60_000;

/**
 * LOGOUT jest szczególny: whatsapp-web.js sam usuwa LocalAuth i wraca do
 * ekranu parowania. Zamknięcie przeglądarki w reakcji na to zdarzenie ściga
 * się z reiniekcją biblioteki i potrafi zostawić uszkodzony profil sesji.
 */
export function shouldRelinkWithoutRestart(reason: string): boolean {
    return reason.trim().toUpperCase() === 'LOGOUT';
}

export interface RestartDecision {
    restart: boolean;
    delayMs: number;
    attempt: number;
    recentAttempts: number[];
    reason: 'clean_exit' | 'auth_failure' | 'qr_unscanned' | 'limit' | 'retry';
}

/**
 * Decyzja jest czysta i łatwa do przetestowania. Próby starsze niż okno
 * wypadają, więc pojedynczy błąd po wielu godzinach zaczyna znów od 5 sekund.
 */
export function decideLoggerRestart(
    exitCode: number | null,
    attempts: readonly number[],
    now = Date.now(),
): RestartDecision {
    const recentAttempts = attempts.filter((at) => now - at < RESTART_WINDOW_MS);

    if (exitCode === 0) {
        return { restart: false, delayMs: 0, attempt: 0, recentAttempts, reason: 'clean_exit' };
    }
    if (exitCode === EXIT_AUTH_FAILURE) {
        return { restart: false, delayMs: 0, attempt: 0, recentAttempts, reason: 'auth_failure' };
    }
    if (exitCode === EXIT_QR_UNSCANNED) {
        return { restart: false, delayMs: 0, attempt: 0, recentAttempts, reason: 'qr_unscanned' };
    }
    if (recentAttempts.length >= RESTART_MAX_ATTEMPTS) {
        return {
            restart: false,
            delayMs: 0,
            attempt: recentAttempts.length,
            recentAttempts,
            reason: 'limit',
        };
    }

    const attempt = recentAttempts.length + 1;
    const delayMs = Math.min(
        RESTART_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
        RESTART_MAX_DELAY_MS,
    );
    return { restart: true, delayMs, attempt, recentAttempts, reason: 'retry' };
}
