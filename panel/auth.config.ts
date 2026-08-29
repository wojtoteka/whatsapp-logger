// Część konfiguracji Auth.js, która musi działać w middleware.
//
// Middleware Next.js chodzi w środowisku Edge, gdzie nie ma sterownika
// MariaDB. Dlatego dostawca logowania (ten, który sięga do bazy) siedzi
// osobno w auth.ts, a tutaj zostaje tylko to, co Edge uniesie: strony,
// rodzaj sesji i decyzja, kogo wpuścić.

import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
    // Sesja w podpisanym ciasteczku. Przy logowaniu hasłem to jedyny
    // sensowny wariant - baza trzyma konta, nie sesje.
    session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 },

    pages: {
        signIn: '/logowanie',
        error: '/logowanie',
    },

    // Za odwrotnym proxy (nginx) Auth.js musi ufać nagłówkom hosta,
    // inaczej po zalogowaniu przekierowałby na zły adres.
    trustHost: true,

    // Dostawcy dochodzą w auth.ts - tutaj ich nie ma, bo ciągną za sobą bazę.
    providers: [],

    callbacks: {
        /** Bez konta nie ma wstępu nigdzie poza stroną logowania. */
        authorized({ auth }) {
            return Boolean(auth?.user);
        },

        jwt({ token, user }) {
            if (user) token.login = user.name;
            return token;
        },

        session({ session, token }) {
            if (session.user && typeof token.login === 'string') {
                session.user.name = token.login;
            }
            return session;
        },
    },
} satisfies NextAuthConfig;
