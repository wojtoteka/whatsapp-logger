# WhatsApp Logger

Narzędzie archiwizujące własne rozmowy z WhatsAppa do przeglądalnych plików HTML. Loguje się przez WhatsApp Web (kod QR, jak przy zwykłym parowaniu urządzenia), nasłuchuje na przychodzące wiadomości i zapisuje je lokalnie razem z mediami.

> **Projekt edukacyjny, do własnego archiwum.** Logger widzi wyłącznie konwersacje konta, którym się zalogujesz. Zanim go użyjesz, upewnij się, że masz prawo archiwizować dane rozmowy - w wielu jurysdykcjach nagrywanie czy zapisywanie cudzych wiadomości bez wiedzy rozmówcy jest problematyczne prawnie.

## Co robi

- **Archiwum w HTML** - wiadomości trafiają do gotowych do czytania plików HTML, dzielonych po 70 wiadomości na plik, w podfolderze per czat.
- **Pobieranie mediów** - zdjęcia, wideo, audio i naklejki są zapisywane na dysk (domyślny limit 100 MB na plik); typy do pobrania ustawia się w konfiguracji.
- **Escapowanie treści** - tekst wiadomości jest sanityzowany przed wstawieniem do HTML, więc treść nie rozwali strony ani nie wstrzyknie się jako znacznik.
- **Bezpieczne nazwy plików** - `sanitize-filename` chroni przed nazwami czatów, które psułyby ścieżki.
- **Powiadomienia na Discordzie** - o utracie autoryzacji, rozłączeniu czy konieczności zeskanowania QR informuje webhook, z osobnym cooldownem dla każdej kategorii alertu (5 min), żeby nie zasypać kanału.
- **Automatyczne wykrywanie Chrome'a** - skrypt sam znajduje instalację Chrome/Chromium na Windowsie i Linuksie, zamiast wymagać ręcznej ścieżki. `PUPPETEER_SKIP_DOWNLOAD=true` w `.npmrc` oszczędza pobierania drugiej kopii przeglądarki.

## Stos

[`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) (Puppeteer pod spodem) · `fs-extra` · `sanitize-filename` · `qrcode-terminal`

## Struktura

```
index.js                  start, wykrywanie Chrome'a, obsługa QR i zdarzeń klienta
src/config.js             ustawienia domyślne (bez sekretów)
src/config.local.js       Twoje prywatne wartości - NIE w repozytorium
src/storage.js            zapis wiadomości, mediów, podział na partie
src/htmlTemplate.js       generowanie plików HTML
src/discord.js            webhook z kolejką i cooldownem per kategoria
```

## Uruchomienie

```bash
npm install
cp src/config.local.example.js src/config.local.js   # opcjonalnie: webhook Discorda
node index.js
```

Przy pierwszym starcie w terminalu pojawi się kod QR - zeskanuj go w telefonie: **WhatsApp → Urządzenia połączone → Połącz urządzenie**. Sesja zostaje zapamiętana, więc kolejne uruchomienia nie wymagają skanowania.

## Prywatność

Trzy rzeczy nigdy nie trafiają do repozytorium i są zablokowane w `.gitignore`:

| Ścieżka | Zawartość |
|---|---|
| `logs/` | Zarchiwizowane rozmowy i pobrane media |
| `.wwebjs_auth/`, `.wwebjs_cache/` | Dane sesji WhatsAppa - dostęp do konta |
| `src/config.local.js` | Webhook Discorda, hasło do zablokowanych czatów |

Konfiguracja jest warstwowa: `config.js` (wartości domyślne, publiczne) → `config.local.js` (Twoje sekrety) → zmienne środowiskowe (najwyższy priorytet). Bez `config.local.js` logger nadal działa, tyle że bez powiadomień na Discordzie.
