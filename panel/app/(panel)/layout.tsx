import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { auth, signOut } from '@/auth';
import { listChats } from '@/lib/archiwum';
import { Nawigacja } from '@/components/Nawigacja';

// Archiwum zmienia się w trakcie działania loggera, więc każda odsłona
// musi powstawać na nowo. Bez tego panel pokazywałby stan z chwili budowania.
export const dynamic = 'force-dynamic';

export default async function UkladPanelu({ children }: { children: ReactNode }) {
    // Middleware odsyła niezalogowanych, ale sprawdzamy też tutaj: gdyby
    // kiedyś zmienił się matcher, archiwum nie ma prawa wyciec przez pomyłkę.
    const session = await auth();
    if (!session?.user) redirect('/logowanie');

    const { rozmowy, relacje } = await listChats();

    async function wyloguj(): Promise<void> {
        'use server';
        await signOut({ redirectTo: '/logowanie' });
    }

    return (
        <div className="shell">
            <Nawigacja
                rozmowy={rozmowy.length}
                relacje={relacje.length}
                login={session.user.name ?? 'konto'}
                wyloguj={wyloguj}
            />
            {children}
        </div>
    );
}
