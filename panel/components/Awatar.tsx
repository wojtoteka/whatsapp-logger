import { fileUrl } from '@/lib/archiwum';
import { initial, senderTone } from '@/lib/format';

interface Props {
    /** Ścieżka względem folderu archiwum albo null. */
    path: string | null;
    name: string;
    size?: 'sm' | 'md' | 'lg';
}

/**
 * Zdjęcie profilowe, a gdy go nie ma - kółko z pierwszą literą nazwy
 * w kolorze przypisanym na stałe do tej osoby.
 */
export function Awatar({ path, name, size = 'md' }: Props) {
    const url = fileUrl(path);

    return (
        <span className={`avatar ${size} ${url ? '' : senderTone(name)}`} aria-hidden={!url}>
            {url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={`Zdjęcie profilowe: ${name}`} loading="lazy" />
            ) : (
                initial(name)
            )}
        </span>
    );
}
