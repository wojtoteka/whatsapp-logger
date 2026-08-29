// Pełna konfiguracja Auth.js: to, co z auth.config.ts, plus logowanie
// loginem i hasłem sprawdzanym w MariaDB.
//
// Konta zakłada logger: npm start -- --uzytkownik

import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authConfig } from './auth.config';
import { verifyUser } from '@/lib/uzytkownicy';

export const { handlers, auth, signIn, signOut } = NextAuth({
    ...authConfig,
    providers: [
        Credentials({
            name: 'Konto panelu',
            credentials: {
                login: { label: 'Login', type: 'text' },
                haslo: { label: 'Hasło', type: 'password' },
            },
            async authorize(credentials) {
                const login = typeof credentials?.login === 'string' ? credentials.login : '';
                const haslo = typeof credentials?.haslo === 'string' ? credentials.haslo : '';

                const user = await verifyUser(login, haslo);
                if (!user) return null;

                return { id: String(user.id), name: user.login };
            },
        }),
    ],
});
