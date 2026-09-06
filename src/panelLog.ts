// Co z wyjścia panelu trafia do konsoli.
//
// Next.js traktuje zerwane połączenie jak błąd renderowania. Gdy przeglądarka
// zamknie kartę albo przerwie żądanie w trakcie strumieniowania strony, React
// przerywa render i zgłasza "The destination stream closed early." razem
// z ramkami stosu i polem digest. W logu wygląda to jak wywrotka panelu,
// choć panel pracuje dalej i nikt nie stracił ani jednej wiadomości.
//
// Zdarza się to regularnie: strona czatu odświeża się sama co 15 sekund
// (panel/components/Odswiezanie.tsx), a przejście do innego czatu albo
// zamknięcie karty w trakcie takiego odświeżenia przerywa żądanie w pół.
// Bramka z lanGuard.ts zamyka wtedy połączenie do panelu i to właśnie widzi
// React. Cały blok zjadamy, ale raz na uruchomienie mówimy, co się dzieje -
// tak samo jak przy pomijanych kanałach.

/** Komunikaty Reacta o zerwanym połączeniu. Nie są awarią panelu. */
const ABORTED_REQUEST = [
    'The destination stream closed early.',
    'The destination stream errored while writing data.',
];

/** Zamiennik pierwszego takiego bloku. */
export const ABORTED_REQUEST_NOTE =
    'przerwane żądanie - ktoś zamknął kartę albo odszedł ze strony w trakcie ' +
    'jej ładowania. Panel działa dalej, kolejne takie zgłoszenia pomijam.';

/**
 * Buduje filtr jednego strumienia: dostaje linię, oddaje to, co ma pójść
 * do konsoli, albo null, gdy linia ma przepaść. Stan jest potrzebny, bo
 * po komunikacie idą jeszcze ramki stosu i klamra z polem digest.
 */
export function createPanelOutputFilter(): (line: string) => string | null {
    let skipping = false;
    let explained = false;

    return (line) => {
        // Dalszy ciąg bloku: wcięte ramki stosu i zamykająca klamra.
        if (skipping && (/^\s/.test(line) || line.trim() === '}')) return null;
        skipping = false;

        if (!ABORTED_REQUEST.some((message) => line.includes(message))) return line;

        skipping = true;
        if (explained) return null;
        explained = true;
        return ABORTED_REQUEST_NOTE;
    };
}
