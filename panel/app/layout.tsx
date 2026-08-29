import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
    title: 'Archiwum WhatsApp',
    description: 'Panel do przeglądania rozmów zapisanych przez WhatsApp Loggera',
};

/**
 * Układ wspólny dla wszystkiego, łącznie ze stroną logowania - dlatego
 * nie ma tu ani nawigacji, ani zaglądania do archiwum. Jedno i drugie
 * siedzi w app/(panel)/layout.tsx, za bramką logowania.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="pl">
            <body>{children}</body>
        </html>
    );
}
