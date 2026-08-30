# WhatsApp Logger

Lokalny archiwizator rozmów z WhatsAppa. Łączy się z kontem przez WhatsApp Web, zapisuje wiadomości i media na dysku, a opcjonalny panel pozwala wygodnie przeglądać archiwum w przeglądarce.

Projekt jest przeznaczony do tworzenia kopii własnych rozmów. Korzysta z nieoficjalnej biblioteki [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js), dlatego zmiany po stronie WhatsApp Web mogą czasem wymagać aktualizacji aplikacji.

## Najważniejsze możliwości

- zapis zwykłych wiadomości, odpowiedzi, ankiet, lokalizacji i wizytówek;
- pasywne archiwizowanie bez oznaczania rozmów jako przeczytane;
- pobieranie zdjęć, filmów, dokumentów, naklejek i nagrań głosowych;
- archiwizacja relacji oraz historii zdjęć profilowych;
- nadrabianie ostatnich wiadomości po ponownym uruchomieniu;
- deduplikacja na podstawie identyfikatorów WhatsAppa;
- obsługa wiadomości z zabezpieczonych czatów;
- automatyczne ponowienie pracy po przejściowym rozłączeniu lub awarii;
- retencja, czyli opcjonalne usuwanie starych wiadomości i mediów;
- pliki HTML do otwierania bez panelu oraz dane JSON wykorzystywane przez panel;
- narzędzie sprawdzające spójność całego archiwum.

## Wymagania

- Node.js 20.6 lub nowszy;
- npm;
- Chrome albo Chromium;
- telefon z WhatsAppem do pierwszego sparowania;
- MariaDB lub MySQL, jeżeli chcesz korzystać z logowania do panelu.

## Szybki start loggera

### Debian - instalacja jednym skryptem

Po skopiowaniu repozytorium na serwer uruchom z jego katalogu:

```bash
bash scripts/instaluj-debian.sh
```

Skrypt sprawdza Node.js, w razie potrzeby instaluje Chromium przez `apt`, instaluje zależności npm loggera i panelu oraz buduje obie części. Istniejące `.env`, `panel/.env`, `logs/`, sesja WhatsAppa i baza danych pozostają nietknięte.

Jeśli nie chcesz instalować systemowego Chromium, uruchom instalator tak:

```bash
bash scripts/instaluj-debian.sh --bez-chromium
```

W tym wariancie Puppeteer musi korzystać z własnej kopii przeglądarki albo z przeglądarki wskazanej przez `CHROME_PATH` w pliku `.env`.

Skrypt nie tworzy bazy ani konta panelu - ten krok jest opisany niżej.

### Instalacja ręczna

1. Zainstaluj zależności:

   ```powershell
   npm install
   ```

2. Utwórz własną konfigurację:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Jeżeli na razie nie potrzebujesz panelu, ustaw w `.env`:

   ```dotenv
   PANEL_ENABLED=false
   ```

4. Uruchom aplikację:

   ```powershell
   npm start
   ```

Przy pierwszym uruchomieniu terminal pokaże kod QR. Zeskanuj go w telefonie przez **WhatsApp → Urządzenia połączone → Połącz urządzenie**. Dane sparowanej sesji zostaną w lokalnym folderze `.wwebjs_auth`, więc przy kolejnych startach kod zwykle nie będzie potrzebny.

Program zatrzymasz skrótem `Ctrl+C`. Przed zakończeniem logger próbuje bezpiecznie dopisać wiadomości oczekujące w pamięci.

## Panel WWW

Panel jest osobną aplikacją Next.js. Czyta dokładnie ten sam folder archiwum co logger i domyślnie działa pod adresem [http://localhost:3000](http://localhost:3000).

### 1. Zależności i konfiguracja

```powershell
Set-Location panel
npm install
Copy-Item .env.example .env
Set-Location ..
```

Wygeneruj losowy klucz sesji:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Skopiuj wynik do `AUTH_SECRET` w `panel/.env`.

### 2. Baza i konto użytkownika

Panel pobiera rozmowy z plików, ale konta do logowania przechowuje w MariaDB/MySQL. Przykładowa konfiguracja bazy:

```sql
CREATE DATABASE whatsapp_logger CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'whatsapp'@'localhost' IDENTIFIED BY 'silne_haslo';
GRANT ALL PRIVILEGES ON whatsapp_logger.* TO 'whatsapp'@'localhost';
FLUSH PRIVILEGES;
```

Uzupełnij te same ustawienia `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` i `DB_NAME` w plikach `.env` oraz `panel/.env`, a następnie wykonaj:

```powershell
npm start -- --baza
npm start -- --uzytkownik
```

Pierwsze polecenie sprawdza połączenie i tworzy potrzebne tabele. Drugie tworzy konto do panelu albo zmienia hasło istniejącego konta. Wpisywane hasło nie jest wyświetlane w terminalu.

Po zakończeniu konfiguracji zwykłe `npm start` uruchamia logger i panel razem. Przy pierwszym starcie panel może potrzebować chwili na zbudowanie wersji produkcyjnej.

## Przydatne polecenia

| Polecenie | Działanie |
|---|---|
| `npm start` | Buduje logger oraz panel z obecnych plików, a następnie uruchamia oba procesy. Nie wykonuje `npm install`. |
| `npm start -- --sprawdz` | Sprawdza konfigurację i kończy pracę bez łączenia z WhatsAppem. |
| `npm start -- --sprawdz-archiwum` | Kontroluje strukturę JSON, duplikaty i brakujące pliki. |
| `npm start -- --nadrob-wszystko` | Jednorazowo nadrabia także czaty, które nie mają jeszcze folderu. |
| `npm start -- --baza` | Sprawdza bazę i tworzy tabele. |
| `npm start -- --uzytkownik` | Tworzy konto panelu lub zmienia jego hasło. |
| `npm run logger` | Uruchamia sam logger bez nadzorcy restartów i bez panelu. |
| `npm run panel` | Uruchamia panel w trybie deweloperskim. |
| `npm test` | Buduje projekt i uruchamia testy. |
| `npm run typecheck` | Sprawdza typy bez generowania plików wynikowych. |

> Automatyczne ponawianie loggera działa przy uruchomieniu przez `npm start`. Polecenie `npm run logger` uruchamia proces bez launchera, więc nie może go samodzielnie wystartować ponownie.

## Jak działa nadrabianie i deduplikacja

Po połączeniu logger przegląda ostatnie wiadomości dostępne w WhatsApp Web. Przy zwykłym starcie robi to wyłącznie dla czatów, które mają już folder w archiwum. Domyślnie zaczyna od 250 pozycji. Jeżeli nie znajdzie zapisanego checkpointu, stopniowo pogłębia okno, maksymalnie do 50 000 wiadomości, zamiast skanować całą historię od początku.

Aby świadomie przeskanować wszystkie czaty widoczne dla sesji i utworzyć foldery także dla wcześniej niearchiwizowanych rozmów, uruchom:

```powershell
npm start -- --nadrob-wszystko
```

To polecenie działa jednorazowo: nie uruchamia panelu i kończy pracę po zapisaniu znalezionych wiadomości. Pobiera listę wszystkich czatów widocznych dla sesji, również nieznanych lokalnie, a dostępną historię przekazuje do loggera partiami po 250 modeli. Limit `BACKFILL_MESSAGES_PER_CHAT` dotyczy tylko zwykłej synchronizacji przyrostowej.

Najpierw wykorzystywany jest stabilny identyfikator nadany przez WhatsApp. Jeżeli wyjątkowo go brakuje, aplikacja tworzy deterministyczny identyfikator zastępczy z czasu i skrótu danych wiadomości. Dzięki temu ta sama wiadomość odebrana na żywo i znaleziona później podczas nadrabiania nie powinna pojawić się dwa razy.

Lista ostatnio widzianych identyfikatorów i ostatni poprawny checkpoint znajdują się w `_state.json` danego czatu. Checkpoint jest zapisywany dopiero po trwałym zapisie pobranej paczki. Nie należy ręcznie usuwać tego pliku podczas działania aplikacji.

Co 15 minut logger wykonuje lekką kontrolę przyrostową znanych czatów. Nie uruchamia dwóch przebiegów równolegle. Odstęp ustawia `SYNC_INTERVAL_MINUTES`, a `0` wyłącza wyłącznie kontrole okresowe.

Pełne nadrabianie oznacza całą historię udostępnioną bieżącej sesji WhatsApp Web, nie gwarancję całej historii konta z telefonu. `whatsapp-web.js` musi najpierw załadować tę historię do swojej strony Chromium; logger odbiera ją później partiami i nie trzyma jednocześnie wszystkich obiektów wiadomości w procesie Node.

## Zabezpieczone czaty

Wiadomości przychodzące na żywo z zabezpieczonych czatów są archiwizowane również wtedy, gdy WhatsApp Web nie otrzymał kodu tajnego z telefonu. W konsoli nazwa takiego czatu ma symbol kłódki, na przykład:

```text
[21:37:04] [Nazwa czatu 🔒] ← Kontakt: treść wiadomości
```

`LOCKED_CHAT_PASSWORD` służy do próby odsłonięcia czatu w sesji webowej, co może pozwolić także na nadrobienie jego wcześniejszej historii. Jeżeli pojawi się komunikat, że WhatsApp Web nie dostał kodu tajnego, nie oznacza to utraty nowych wiadomości - ograniczenie dotyczy historii ukrytej przed tą sesją.

Kod tajny i lista zabezpieczonych czatów nie są zapisywane w archiwum.

## Automatyczne odzyskiwanie po awarii

Gdy logger straci połączenie albo zakończy się przez przejściowy błąd, launcher zapisuje stan i uruchamia go ponownie z rosnącym opóźnieniem: 5, 10, 20, 40, a następnie maksymalnie 60 sekund.

W ciągu 15 minut wykonywanych jest najwyżej osiem prób. Po przekroczeniu limitu aplikacja zatrzymuje się, żeby nie wpadać w nieskończoną pętlę. Utrata autoryzacji również zatrzymuje restarty, ponieważ wymaga ponownego sparowania telefonu.

## Konfiguracja `.env`

Pełny wzór z komentarzami znajduje się w `.env.example`. Pusta wartość oznacza ustawienie domyślne, a zmienna środowiskowa systemu ma pierwszeństwo przed plikiem.

### Archiwum i wiadomości

| Zmienna | Domyślnie | Znaczenie |
|---|---:|---|
| `LOGS_DIR` | `./logs` | Folder archiwum. |
| `MESSAGES_PER_FILE` | `70` | Liczba wiadomości w jednej zamkniętej partii HTML/JSON. |
| `BACKFILL_MESSAGES_PER_CHAT` | `250` | Liczba ostatnich wiadomości sprawdzanych w istniejących archiwach; `0` wyłącza. |
| `SYNC_INTERVAL_MINUTES` | `15` | Odstęp lekkiej synchronizacji przyrostowej znanych czatów; `0` wyłącza. |
| `STATE_SAVE_INTERVAL_MS` | `5000` | Minimalny odstęp między zapisami `_state.json`; `0` zapisuje po każdej zmianie. |
| `MEDIA_TYPES` | wszystkie | Typy pobieranych mediów oddzielone przecinkami. |
| `MAX_MEDIA_SIZE_MB` | `100` | Maksymalny rozmiar pojedynczego pobieranego pliku. |

### Relacje, awatary i retencja

| Zmienna | Domyślnie | Znaczenie |
|---|---:|---|
| `SAVE_PROFILE_PICS` | `true` | Zapisuje zdjęcia profilowe i historię zmian. |
| `AVATAR_REFRESH_DAYS` | `30` | Odstęp między sprawdzaniem zdjęć profilowych. |
| `SAVE_STATUSES` | `true` | Archiwizuje relacje. |
| `SWEEP_CHECK_HOURS` | `6` | Odstęp między przeglądami relacji i awatarów. |
| `RETENTION_ENABLED` | `true` | Włącza automatyczne usuwanie starych danych. |
| `RETENTION_DAYS` | `180` | Wiek usuwanych wiadomości i mediów w dniach. |
| `RETENTION_CHECK_HOURS` | `12` | Odstęp między kontrolami retencji. |

### Panel, baza i integracje

| Zmienna | Domyślnie | Znaczenie |
|---|---:|---|
| `PANEL_ENABLED` | `true` | Uruchamia panel razem z loggerem. |
| `PANEL_HOST` | `127.0.0.1` | Adres nasłuchiwania panelu. |
| `PANEL_PORT` | `3000` | Port panelu. |
| `DB_ENABLED` | `false` | Włącza dodatkowy zapis wiadomości do bazy SQL. Konta panelu korzystają z bazy niezależnie od tej opcji. |
| `DB_HOST`, `DB_PORT` | `127.0.0.1`, `3306` | Adres i port bazy. |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | - | Dane dostępowe do bazy. |
| `LOCKED_CHAT_PASSWORD` | puste | Kod do próby odsłonięcia zabezpieczonych czatów. |
| `DISCORD_WEBHOOK_URL` | puste | Webhook powiadomień; puste wyłącza integrację. |
| `DISCORD_PING_USER_ID` | puste | Użytkownik oznaczany przy QR lub utracie autoryzacji. |

### Przeglądarka i diagnostyka

| Zmienna | Domyślnie | Znaczenie |
|---|---:|---|
| `CHROME_PATH` | automatycznie | Ręczna ścieżka do Chrome/Chromium. |
| `HEADLESS` | `true` | `false` pokazuje okno przeglądarki. |
| `LOG_LEVEL` | `info` | Poziom logowania: `debug`, `info`, `warn` albo `error`. |

`PANEL_HOST=127.0.0.1` udostępnia panel wyłącznie na bieżącym komputerze. Ustawienie `0.0.0.0` wystawia go na wszystkie interfejsy sieciowe; rób to tylko w zaufanej sieci i po ustawieniu silnego hasła.

## Struktura archiwum

```text
logs/
├── Nazwa czatu/
│   ├── messages_0001.html
│   ├── messages_0001.json
│   ├── media/
│   └── _state.json
├── Statusy/
│   └── Nazwa kontaktu/
├── _avatars/
│   ├── identyfikator-kontaktu/
│   └── _historia.json
├── _czaty.json
├── _bledy.json
└── _kasowanie.log
```

- `messages_XXXX.html` to gotowe do czytania części rozmowy;
- `messages_XXXX.json` zawierają te same partie dla panelu;
- `_state.json` przechowuje jeszcze niezamkniętą partię i identyfikatory do deduplikacji;
- `_czaty.json` mapuje identyfikatory WhatsAppa na foldery archiwum;
- `media` zawiera pobrane załączniki.

## Kontrola archiwum

Przed wykonaniem kopii zapasowej albo po awarii uruchom:

```powershell
npm start -- --sprawdz-archiwum
```

Polecenie nie łączy się z WhatsAppem i nie uruchamia panelu. Sprawdza między innymi:

- poprawność `_czaty.json`, `_state.json` i partii wiadomości;
- duplikaty identyfikatorów;
- zgodność par HTML/JSON;
- brakujące media i awatary;
- odnośniki próbujące wyjść poza folder archiwum.

Kod zakończenia różny od zera oznacza znalezienie błędu.

## Prywatność i bezpieczeństwo

Te katalogi i pliki zawierają prywatne dane i są ignorowane przez Git:

| Ścieżka | Zawartość |
|---|---|
| `.env` | Hasła, webhook i dane bazy loggera. |
| `panel/.env` | Klucz sesji i dane bazy panelu. |
| `logs/` | Wiadomości, zdjęcia, filmy, dokumenty i awatary. |
| `.wwebjs_auth/` | Aktywna sesja WhatsAppa. |
| `.wwebjs_cache/` | Pamięć podręczna WhatsApp Web. |

Nie publikuj żadnego z nich i nie wysyłaj folderu `.wwebjs_auth` innym osobom. Dostęp do tego folderu może oznaczać dostęp do sparowanej sesji konta.

Repozytorium ma dodatkowy hook kontrolujący najczęstsze wycieki. Po świeżym sklonowaniu włącz go poleceniem:

```powershell
git config core.hooksPath .githooks
```

Hook jest dodatkowym zabezpieczeniem, a nie zamiennikiem sprawdzenia zmian przed publikacją.

## Rozwiązywanie problemów

| Problem | Rozwiązanie |
|---|---|
| Nie pojawia się kod QR | Ustaw `HEADLESS=false` i sprawdź błędy startu przeglądarki. |
| Chrome nie jest wykrywany | Ustaw pełną ścieżkę w `CHROME_PATH`. |
| Sesja straciła autoryzację | Zatrzymaj program, usuń lokalny folder `.wwebjs_auth` i sparuj konto ponownie. |
| Folder czatu ma nazwę złożoną z cyfr | Poczekaj na synchronizację kontaktów; po znalezieniu lepszej nazwy logger potrafi przenieść archiwum. |
| Pojawia się komunikat o częściowych danych WhatsApp Web | Zaktualizuj `whatsapp-web.js` i ponownie przetestuj aplikację. |
| Zbiorcze pobranie czatów kończy się krótkim błędem `r: r` | Logger próbuje rozwinąć czaty pojedynczo, dzięki czemu jeden wadliwy model nie blokuje całego nadrabiania. Liczba pominiętych czatów pojawi się w podsumowaniu. |
| Zabezpieczony czat nie został odsłonięty | Nowe wiadomości nadal są zapisywane; WhatsApp Web może jedynie nie udostępnić wcześniejszej historii. |
| Panel nie startuje | Uruchom `npm run panel:build`, a potem ponownie `npm start`. |
| Panel pokazuje błąd konfiguracji | Sprawdź `AUTH_SECRET` w `panel/.env`. |
| Nie można zalogować się do panelu | `npm start -- --baza` sprawdzi bazę, a `npm start -- --uzytkownik <login>` ustawi hasło ponownie. Konsola panelu rozróżnia brak konta, niepasujące hasło i błąd SQL. |
| Panel widzi inny lub pusty folder | Sprawdź `LOGS_DIR`; launcher przekazuje panelowi ścieżkę używaną przez logger. |
| Potrzebne są szczegóły awarii | Zajrzyj do `logs/_bledy.json` albo ustaw `LOG_LEVEL=debug`. |

## Uwagi

- Logger nie wywołuje `sendSeen` ani `markChatUnread`; pobieranie historii nie oznacza wiadomości jako przeczytanych. Ostateczne zachowanie samego WhatsApp Web może się jednak zmienić po jego aktualizacji.
- Aplikacja nie odzyska wiadomości, których WhatsApp Web nie udostępnia bieżącej sesji.
- Usunięcie danych sesji wymusza ponowne sparowanie urządzenia.
- Włączenie retencji oznacza rzeczywiste usuwanie starszych plików z lokalnego archiwum.
- Archiwizuj wyłącznie dane, do których masz prawo, i odpowiednio zabezpiecz kopie zapasowe.
