'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MaterialIcon } from './MaterialIcon';

interface Props {
    rozmowy: number;
    relacje: number;
    login: string;
    /** Akcja serwerowa wylogowania - przekazana z układu panelu. */
    wyloguj: () => Promise<void>;
}

/**
 * Pasek na górze. Jest komponentem klienckim tylko z jednego powodu:
 * musi wiedzieć, na której zakładce jesteśmy, żeby ją podświetlić.
 */
export function Nawigacja({ rozmowy, relacje, login, wyloguj }: Props) {
    const pathname = usePathname();

    const zakladki = [
        {
            href: '/',
            label: 'Rozmowy',
            count: rozmowy,
            active: pathname === '/' || pathname.startsWith('/czat'),
        },
        { href: '/relacje', label: 'Relacje', count: relacje, active: pathname.startsWith('/relacje') },
    ];

    return (
        <header className="masthead">
            <Link className="brand" href="/">
                WhatsApp <span>Archiwum</span>
            </Link>

            <nav className="tabs" aria-label="Kategorie archiwum">
                {zakladki.map((z) => (
                    <Link
                        key={z.href}
                        href={z.href}
                        className="tab"
                        aria-current={z.active ? 'page' : undefined}
                    >
                        {z.label}
                        <span className="count">{z.count}</span>
                    </Link>
                ))}

                <form action={wyloguj}>
                    <button type="submit" className="tab logout" title={`Zalogowany jako ${login}`}>
                        <span className="login-name">{login}</span>
                        <MaterialIcon name="logout" className="logout-icon" />
                    </button>
                </form>
            </nav>
        </header>
    );
}
