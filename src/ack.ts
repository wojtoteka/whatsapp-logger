// Potwierdzenia doręczenia i odczytania własnych wiadomości.
//
// WhatsApp nie podaje godziny, o której odbiorca otworzył rozmowę - podaje samą
// zmianę stanu ("ack"), i to tylko dopóki program działa. Dlatego zapisujemy
// dwie różne rzeczy i nie mieszamy ich ze sobą:
//
//  - ack       - najwyższy stan, jaki widzieliśmy. Da się go odczytać także
//                później, z modelu wiadomości, więc przeżywa restart.
//  - readAt    - chwila, w której to my zobaczyliśmy zmianę na "przeczytana".
//                Jest tylko wtedy, gdy program w tym momencie pracował.
//
// Stąd wiadomość bywa oznaczona jako przeczytana bez godziny odczytu. To nie
// jest brak danych do naprawienia - to uczciwe "wiem, że przeczytał, nie wiem
// kiedy". Zmyślenie tu godziny byłoby gorsze niż jej brak.

import type { ArchivedMessage, WaMessage } from './types';

/** Stany doręczenia w kolejności, w jakiej podaje je WhatsApp. */
export const ACK = {
    ERROR: -1,
    PENDING: 0,
    SERVER: 1,
    /** Doszła na telefon odbiorcy. */
    DEVICE: 2,
    READ: 3,
    /** Odsłuchana - dotyczy wiadomości głosowych i filmów. */
    PLAYED: 4,
} as const;

/** Ta część wiadomości, którą dotyka potwierdzenie. */
export type AckFields = Pick<ArchivedMessage, 'ack' | 'deliveredAt' | 'readAt'>;

/** Stan doręczenia z wiadomości WhatsAppa albo null, gdy go nie podał. */
export function ackOf(message: WaMessage | null): number | null {
    const value = (message as (WaMessage & { ack?: unknown }) | null)?.ack;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Czy odbiorca to przeczytał. */
export function isRead(ack: number | null | undefined): boolean {
    return typeof ack === 'number' && ack >= ACK.READ;
}

/** Czy doszło chociaż na telefon odbiorcy. */
export function isDelivered(ack: number | null | undefined): boolean {
    return typeof ack === 'number' && ack >= ACK.DEVICE;
}

/**
 * Nanosi nowy stan na wiadomość. Zwraca true, gdy cokolwiek się zmieniło -
 * dzięki temu wołający wie, czy ma po co zapisywać pliki.
 *
 * `at` to chwila obserwacji albo null, gdy stan odczytaliśmy z modelu po fakcie
 * i nie mamy prawa twierdzić, kiedy to się stało.
 */
export function applyAck(entry: AckFields, ack: number | null, at: string | null): boolean {
    if (ack === null || !Number.isFinite(ack)) return false;

    const before = typeof entry.ack === 'number' ? entry.ack : null;

    // Stan potrafi się cofnąć: po ponownym połączeniu z telefonem WhatsApp
    // bywa, że zaczyna liczyć od nowa. W archiwum zostaje najwyższy, jaki
    // widzieliśmy - inaczej "przeczytana" znikałoby samo z siebie.
    const highest = before === null ? ack : Math.max(before, ack);

    let changed = false;
    if (highest !== before) {
        entry.ack = highest;
        changed = true;
    }

    // Każda godzina opisuje chwilę, w której zobaczyliśmy dokładnie ten krok.
    // Wiadomość potrafi przeskoczyć od razu na "przeczytana" - wtedy godziny
    // doręczenia po prostu nie znamy i lepiej jej nie mieć niż wpisać tam
    // moment odczytu, który znaczy co innego.
    if (at !== null && isDelivered(highest) && !isRead(highest) && !entry.deliveredAt) {
        entry.deliveredAt = at;
        changed = true;
    }
    if (at !== null && isRead(highest) && !entry.readAt) {
        entry.readAt = at;
        changed = true;
    }

    return changed;
}
