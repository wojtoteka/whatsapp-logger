// Odsłanianie czatów zabezpieczonych kodem w interfejsie WhatsApp Weba.
//
// WAŻNE, żeby nie czytać stąd fałszywych alarmów: archiwizacja NIE zależy
// od tego modułu. Wiadomości zbieramy ze zdarzeń "message" i
// "message_create", a te lecą również z czatów zablokowanych - blokada jest
// zabezpieczeniem interfejsu, nie filtrem na strumieniu wiadomości.
// Nigdzie nie wołamy getChats(), więc nie ma czego odblokowywać, żeby czat
// trafił do logów. Pierwsza wersja loggera nie miała ani jednej linijki
// obsługi blokady i archiwizowała zablokowane czaty bez problemu.
//
// Ta próba zmienia tylko jedno: czy zablokowane czaty są widoczne w
// interfejsie tej konkretnej sesji przeglądarki. Przy headless nie ogląda
// go nikt, więc traktujemy wynik jako ciekawostkę, nie jako błąd.
//
// whatsapp-web.js nie udostępnia tej funkcji, dlatego sięgamy po moduł,
// z którego korzysta sam interfejs WhatsApp Weba. Hasło, lista czatów ani
// żadne raporty diagnostyczne nie są zapisywane na dysk.
//
// Uwaga na moment wywołania: zdarzenie "ready" leci, gdy tylko wstrzyknie
// się window.Store, a to bywa jeszcze przed zsynchronizowaniem danych.
// Dlatego ponawiamy próbę, dopóki moduł nie odpowie sensownie.

import { describeError, log } from './log';
import type { WaClient } from './types';
import { sleep } from './util';

const MODULE_NAME = 'WAWebChatLockUtils';

export type UnlockStatus =
    /** Brak hasła w .env - obsługa świadomie wyłączona. */
    | 'disabled'
    /** Udało się: zabezpieczone czaty są widoczne w tej sesji. */
    | 'granted'
    /** Hasło nie pasuje do kodu ustawionego w WhatsAppie. */
    | 'invalid_password'
    /** WhatsApp Web nie dostał kodu tajnego z telefonu. */
    | 'not_enabled'
    /** Kod przeszedł, ale czaty i tak się nie odsłoniły. */
    | 'not_granted'
    /** Ta wersja WhatsApp Weba nie ma potrzebnych funkcji. */
    | 'unsupported'
    /** Nie dało się dosięgnąć przeglądarki albo modułu. */
    | 'unavailable'
    /** Coś poszło nie tak w środku przeglądarki. */
    | 'error';

export interface UnlockResult {
    status: UnlockStatus;
    /** Treść błędu ze strony, gdy status to "error". Inaczej pusty. */
    detail?: string | null;
    /**
     * Ile czatów WhatsApp Web widzi jako zablokowane. Rozróżnia dwie
     * zupełnie różne sytuacje o tym samym objawie: nie masz zablokowanych
     * czatów, albo masz, tylko kod tajny nie doszedł do tej sesji.
     */
    lockedCount?: number | null;
}

export interface UnlockOptions {
    /** Ile razy ponawiamy, zanim uznamy, że moduł się nie pojawi. */
    tries?: number;
    /** Odstęp między próbami. */
    waitMs?: number;
}

/**
 * Podaje kod z konfiguracji i odsłania zabezpieczone czaty w bieżącej sesji.
 * Zwraca jeden, krótki status - resztę wyjaśnia statusLine().
 */
export async function unlock(
    client: WaClient,
    password: string,
    options: UnlockOptions = {},
): Promise<UnlockResult> {
    if (typeof password !== 'string' || password.trim().length === 0) {
        return { status: 'disabled' };
    }

    const page = client?.pupPage;
    if (!page || typeof page.evaluate !== 'function') {
        return { status: 'unavailable' };
    }

    const tries = Math.max(1, options.tries ?? 20);
    const waitMs = options.waitMs ?? 500;

    let result: UnlockResult = { status: 'unavailable' };

    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            result = await page.evaluate(runInPage, password, MODULE_NAME);
        } catch (err) {
            log.quiet(err, { stage: 'zabezpieczone czaty' });
            result = { status: 'error', detail: describeError(err) };
        }

        // Powód błędu ze strony też ma trafić do pliku - komunikat startowy
        // odsyła do logs/_bledy.json, więc musi tam faktycznie coś być.
        if (result.status === 'error' && result.detail) {
            log.quiet(new Error(result.detail), { stage: 'zabezpieczone czaty' });
        }

        // "unavailable" znaczy, że modułu jeszcze nie ma - WhatsApp Web
        // dopiero się ładuje. Każdy inny status jest już rozstrzygnięciem.
        if (result.status !== 'unavailable') return result;
        if (attempt < tries && waitMs > 0) await sleep(waitMs);
    }

    return result;
}

/**
 * Kod wykonywany w kontekście strony WhatsApp Weba. Musi być samodzielny -
 * nie widzi niczego z modułów Node.
 */
async function runInPage(secret: string, moduleName: string): Promise<UnlockResult> {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const win = globalThis as any;

    let utils: any;
    try {
        utils = win.require(moduleName);
    } catch {
        return { status: 'unavailable' };
    }
    if (!utils) return { status: 'unavailable' };

    try {
        if (
            typeof utils.lockedChatsAreAccessible === 'function' &&
            (await utils.lockedChatsAreAccessible())
        ) {
            return { status: 'granted' };
        }

        if (typeof utils.validateSecretCode !== 'function') return { status: 'unsupported' };

        // Kod podajemy zawsze, bez wcześniejszego wypytywania WhatsAppa,
        // czy w ogóle jest ustawiony. hasChatlockSecretCode() potrafi
        // odpowiedzieć "nie" jeszcze zanim dane się zsynchronizują, a wtedy
        // odbijaliśmy się od tego pytania, nie próbując nawet hasła.
        // Funkcja bierze dwa argumenty: kod i kontekst zdarzenia
        // telemetrycznego. Drugi jest opcjonalny i nie wpływa na wynik.
        if (!(await utils.validateSecretCode(secret, null))) {
            // Dopiero teraz ma sens rozróżnienie: nie ma kodu w WhatsAppie,
            // czy jest, tylko inny niż w .env.
            let codeSet: boolean | null = null;
            try {
                if (typeof utils.hasChatlockSecretCode === 'function') {
                    codeSet = Boolean(await utils.hasChatlockSecretCode());
                }
            } catch {
                /* nie wiadomo - zostaje samo "hasło nie pasuje" */
            }

            // Ile czatów jest zablokowanych - po tym poznajemy, czy problem
            // leży w haśle, czy w tym, że kod w ogóle nie doszedł do sesji.
            let lockedCount: number | null = null;
            try {
                if (typeof utils.getLockedChats === 'function') {
                    const chats: unknown = await utils.getLockedChats();
                    lockedCount = Array.isArray(chats) ? chats.length : null;
                }
            } catch {
                /* nieistotne dla samego wyniku */
            }

            return {
                status: codeSet === false ? 'not_enabled' : 'invalid_password',
                lockedCount,
            };
        }

        // validateSecretCode tylko sprawdza kod. Interfejs WhatsAppa po
        // poprawnej walidacji wysyła jeszcze to polecenie, które faktycznie
        // odsłania czaty w bieżącej karcie.
        let triggered = false;
        try {
            const cmd = win.require('WAWebCmd')?.Cmd;
            if (typeof cmd?.trigger === 'function') {
                await cmd.trigger('chatlock:unlock');
                triggered = true;
            }
        } catch {
            /* niżej próbujemy zgodności przez Store */
        }

        if (!triggered && typeof win.Store?.Cmd?.trigger === 'function') {
            await win.Store.Cmd.trigger('chatlock:unlock');
            triggered = true;
        }
        if (!triggered) return { status: 'unsupported' };

        if (typeof utils.lockedChatsAreAccessible !== 'function') return { status: 'granted' };

        // Zwykle stan zmienia się od razu, ale dajemy interfejsowi
        // maksymalnie pół sekundy na obsłużenie polecenia.
        for (let poll = 0; poll < 20; poll++) {
            if (await utils.lockedChatsAreAccessible()) return { status: 'granted' };
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return { status: 'not_granted' };
    } catch (err: any) {
        return { status: 'error', detail: String(err?.message ?? err ?? 'bez treści') };
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Jeden czytelny komunikat startowy. Żaden z tych stanów nie jest awarią -
 * archiwum powstaje niezależnie od nich (patrz komentarz na górze pliku),
 * więc nic tu nie krzyczy "✗", żeby nie sugerować utraty wiadomości.
 */
export function statusLine(result: UnlockResult | null | undefined): string {
    const zawsze = 'Zablokowane czaty i tak trafiają do archiwum.';

    switch (result?.status) {
        case 'disabled':
            return `Zabezpieczone czaty: bez hasła w .env, nie próbuję odsłaniać. ${zawsze}`;
        case 'granted':
            return '✓ Zabezpieczone czaty: odsłonięte w tej sesji.';
        case 'invalid_password':
            return `Zabezpieczone czaty: LOCKED_CHAT_PASSWORD nie pasuje do kodu z WhatsAppa. ${zawsze}`;
        case 'not_enabled':
            // Dwie różne przyczyny tego samego objawu, więc dwa komunikaty.
            return (result?.lockedCount ?? 0) > 0
                ? 'Zabezpieczone czaty: WhatsApp Web nie dostał kodu tajnego z telefonu ' +
                  `(widzi ${String(result?.lockedCount)} zablokowanych). ${zawsze}`
                : `Zabezpieczone czaty: nie ma tu żadnego zablokowanego czatu ani kodu tajnego. ${zawsze}`;
        case 'not_granted':
            return `Zabezpieczone czaty: kod przeszedł, ale interfejs ich nie odsłonił. ${zawsze}`;
        case 'unsupported':
            return `Zabezpieczone czaty: ta wersja WhatsApp Weba nie pozwala ich odsłonić. ${zawsze}`;
        case 'unavailable':
            return `Zabezpieczone czaty: WhatsApp Web nie udostępnił potrzebnego modułu. ${zawsze}`;
        default: {
            const why = result?.detail ? `: ${result.detail}` : '';
            return `Zabezpieczone czaty: nieoczekiwany błąd${why} (szczegóły w logs/_bledy.json). ${zawsze}`;
        }
    }
}
