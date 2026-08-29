import { Fragment } from 'react';

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s]+/gi;

/**
 * Treść wiadomości z klikalnymi adresami.
 *
 * Tekst wstawiamy jako zwykłe dzieci elementu, więc React sam go escapuje -
 * nie ma tu nigdzie dangerouslySetInnerHTML i nie da się wstrzyknąć znacznika
 * przez treść wiadomości.
 */
export function Tresc({ text }: { text: string }) {
    const parts: Array<{ kind: 'text' | 'link'; value: string; href?: string }> = [];
    let lastIndex = 0;

    for (const match of text.matchAll(URL_PATTERN)) {
        const start = match.index ?? 0;
        let url = match[0];
        let tail = '';

        // Kropka czy nawias na końcu zdania nie należą do adresu.
        while (/[.,;:!?)\]}]$/.test(url)) {
            tail = url.slice(-1) + tail;
            url = url.slice(0, -1);
        }
        if (!url) continue;

        if (start > lastIndex) {
            parts.push({ kind: 'text', value: text.slice(lastIndex, start) });
        }
        parts.push({
            kind: 'link',
            value: url,
            href: url.toLowerCase().startsWith('www.') ? `https://${url}` : url,
        });
        if (tail) parts.push({ kind: 'text', value: tail });

        lastIndex = start + match[0].length;
    }

    if (lastIndex < text.length) {
        parts.push({ kind: 'text', value: text.slice(lastIndex) });
    }

    return (
        <>
            {parts.map((part, index) =>
                part.kind === 'link' ? (
                    <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
                        {part.value}
                    </a>
                ) : (
                    <Fragment key={index}>{part.value}</Fragment>
                ),
            )}
        </>
    );
}
