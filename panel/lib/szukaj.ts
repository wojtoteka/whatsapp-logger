// Szukanie po nazwach czatów.
//
// Dwie rzeczy, które muszą działać, żeby wyszukiwarka nie irytowała:
// "lukasz" ma znajdować "Łukasz", a znaleziony fragment trzeba umieć
// podświetlić w oryginalnym napisie - razem z ogonkami, wielkością liter
// i wszystkim, co użytkownik faktycznie widzi na ekranie.

/**
 * Napis bez ogonków i wielkich liter.
 *
 * NFD rozkłada "ą" na "a" i osobny znak diakrytyczny, więc wystarczy usunąć
 * te znaki. Wyjątkiem jest "ł": w Unicode jest osobną literą bez rozkładu,
 * NFD w ogóle jej nie rusza - stąd druga podmiana.
 */
export function bezOgonkow(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split('ł')
        .join('l');
}

/** Napis do porównań razem z mapą "znak w porównaniu -> znak w oryginale". */
interface Uproszczony {
    plain: string;
    /** Dla każdego znaku `plain` indeks znaku, z którego powstał. */
    source: number[];
}

/**
 * Upraszcza znak po znaku, zamiast całości naraz.
 *
 * Całość naraz byłaby krótsza, ale nie dałaby się z powrotem przełożyć na
 * oryginał: gdyby jakikolwiek znak uprościł się do innej długości, wszystkie
 * dalsze trafienia podświetlałyby się przesunięte o kilka liter.
 */
function uprosc(text: string): Uproszczony {
    let plain = '';
    const source: number[] = [];

    for (let i = 0; i < text.length; i++) {
        const piece = bezOgonkow(text[i]!);
        plain += piece;
        for (let j = 0; j < piece.length; j++) source.push(i);
    }

    return { plain, source };
}

/** Nazwa rozbita na to, co przed trafieniem, samo trafienie i resztę. */
export interface Trafienie {
    before: string;
    match: string;
    after: string;
}

/**
 * Szuka fragmentu w napisie, nie zważając na ogonki ani wielkość liter.
 * Zwraca null, gdy nie ma trafienia - to samo pytanie odpowiada więc i za
 * filtrowanie listy, i za podświetlenie na karcie.
 */
export function znajdz(text: string, query: string): Trafienie | null {
    const needle = bezOgonkow(query.trim());
    if (!needle) return { before: '', match: '', after: text };

    const { plain, source } = uprosc(text);
    const at = plain.indexOf(needle);
    if (at < 0) return null;

    // Koniec liczymy z ostatniego trafionego znaku, a nie z pierwszego za nim:
    // ten drugi mógł się uprościć do pustki i nie mieć własnego indeksu.
    const start = source[at] ?? 0;
    const end = (source[at + needle.length - 1] ?? start) + 1;

    return {
        before: text.slice(0, start),
        match: text.slice(start, end),
        after: text.slice(end),
    };
}
