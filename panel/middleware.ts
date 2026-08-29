// Bramka wejściowa: bez zalogowania nie ma dostępu do niczego.
//
// Middleware chodzi w środowisku Edge, więc korzysta z auth.config.ts,
// gdzie nie ma sterownika bazy - sprawdza tylko podpisane ciasteczko sesji.

import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

export const { auth: middleware } = NextAuth(authConfig);
export default middleware;

export const config = {
    // Pomijamy trasy Auth.js (inaczej logowanie blokowałoby samo siebie),
    // pliki statyczne i favicon. Cała reszta, łącznie z /api/plik, wymaga sesji.
    matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico).*)'],
};
