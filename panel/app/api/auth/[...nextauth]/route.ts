// Punkty wejścia Auth.js: logowanie, wylogowanie, odczyt sesji.
//
// W Auth.js v5 obsługę tras dostajemy jako obiekt "handlers", a nie
// jako osobne eksporty GET/POST.

import { handlers } from '@/auth';

export const { GET, POST } = handlers;
