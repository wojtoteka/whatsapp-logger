import type { CSSProperties } from 'react';

const FILES = {
    logout: 'logout.svg',
    attachment: 'attach_file.svg',
    delete: 'delete.svg',
    forward: 'forward.svg',
    arrowBack: 'arrow_back.svg',
    arrowForward: 'arrow_forward.svg',
    done: 'done.svg',
    doneAll: 'done_all.svg',
} as const;

export type MaterialIconName = keyof typeof FILES;

interface Props {
    name: MaterialIconName;
    className?: string;
    /** Podaj tylko wtedy, gdy sama ikona niesie znaczenie. */
    label?: string;
}

/**
 * Lokalne SVG Material Symbols od Google. Maska przyjmuje bieżący kolor
 * tekstu, więc jedna ikona działa na jasnym przycisku i ciemnym dymku.
 */
export function MaterialIcon({ name, className = '', label }: Props) {
    const style = {
        '--material-icon': `url('/icons/${FILES[name]}')`,
    } as CSSProperties;

    return (
        <span
            className={`material-icon ${className}`.trim()}
            style={style}
            role={label ? 'img' : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
        />
    );
}
