import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { auth, signIn } from '@/auth';
import { hasAnyUser } from '@/lib/uzytkownicy';

export const dynamic = 'force-dynamic';

export const metadata = {
    title: 'Logowanie - Archiwum WhatsApp',
};

interface Props {
    searchParams: Promise<{ blad?: string; powrot?: string; callbackUrl?: string }>;
}

/**
 * Dokąd wrócić po zalogowaniu. Middleware Auth.js podaje pełny adres
 * w callbackUrl, my przekazujemy samą ścieżkę w powrot.
 *
 * Bierzemy wyłącznie ścieżkę i tylko taką, która zaczyna się od jednego
 * ukośnika - inaczej dałoby się podstawić cudzy adres i zrobić z logowania
 * przekierowanie na obcą stronę.
 */
function bezpiecznyPowrot(...kandydaci: Array<string | undefined>): string {
    for (const kandydat of kandydaci) {
        if (!kandydat) continue;

        let sciezka = kandydat;
        if (/^https?:\/\//i.test(kandydat)) {
            try {
                const url = new URL(kandydat);
                sciezka = url.pathname + url.search;
            } catch {
                continue;
            }
        }
        if (sciezka.startsWith('/') && !sciezka.startsWith('//')) return sciezka;
    }
    return '/';
}

export default async function StronaLogowania({ searchParams }: Props) {
    // Zalogowanego nie ma po co trzymać na tej stronie.
    const session = await auth();
    if (session?.user) redirect('/');

    const { blad, powrot, callbackUrl } = await searchParams;
    const cel = bezpiecznyPowrot(powrot, callbackUrl);
    const kontaIstnieja = await hasAnyUser();

    async function zaloguj(formData: FormData): Promise<void> {
        'use server';

        const dokad = bezpiecznyPowrot(String(formData.get('powrot') ?? ''));
        try {
            await signIn('credentials', {
                login: String(formData.get('login') ?? ''),
                haslo: String(formData.get('haslo') ?? ''),
                redirectTo: dokad,
            });
        } catch (error) {
            // signIn sygnalizuje udane przekierowanie wyjątkiem, więc
            // przepuszczamy wszystko, co nie jest błędem uwierzytelnienia.
            if (error instanceof AuthError) {
                const powrotem = dokad !== '/' ? `&powrot=${encodeURIComponent(dokad)}` : '';
                redirect(`/logowanie?blad=1${powrotem}`);
            }
            throw error;
        }
    }

    return (
        <main className="login-wrap">
            <form className="login-card" action={zaloguj}>
                <h1>Archiwum WhatsApp</h1>
                <p className="login-sub">Panel jest zamknięty. Zaloguj się, żeby zobaczyć rozmowy.</p>

                {blad && (
                    <p className="login-error" role="alert">
                        Nieprawidłowy login lub hasło.
                    </p>
                )}

                {!kontaIstnieja && (
                    <p className="login-hint">
                        Nie ma jeszcze żadnego konta. Załóż je poleceniem:
                        <code>npm start -- --uzytkownik</code>
                        Jeśli to nie pomaga, sprawdź połączenie z bazą:
                        <code>npm start -- --baza</code>
                    </p>
                )}

                <label>
                    <span>Login</span>
                    <input name="login" type="text" autoComplete="username" required autoFocus />
                </label>

                <label>
                    <span>Hasło</span>
                    <input name="haslo" type="password" autoComplete="current-password" required />
                </label>

                <input type="hidden" name="powrot" value={cel} />

                <button type="submit">Zaloguj</button>
            </form>
        </main>
    );
}
