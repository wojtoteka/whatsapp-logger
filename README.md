# WhatsApp Logger

Lokalny archiwizator rozmów z WhatsAppa. Łączy się z kontem przez WhatsApp Web, zapisuje wiadomości i media na dysku, a opcjonalny panel pozwala wygodnie przeglądać archiwum w przeglądarce.

Projekt jest przeznaczony do tworzenia kopii własnych rozmów. Korzysta z nieoficjalnej biblioteki [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js), dlatego zmiany po stronie WhatsApp Web mogą czasem wymagać aktualizacji aplikacji.

## Najważniejsze możliwości

- zapis zwykłych wiadomości, odpowiedzi, ankiet, lokalizacji i wizytówek;
- pasywne archiwizowanie bez oznaczania rozmów jako przeczytane;
- pobieranie zdjęć, filmów, dokumentów, naklejek i nagrań głosowych;
- archiwizacja relacji oraz historii zdjęć profilowych;
- nadrabianie ostatnich wiadomości po ponownym uruchomieniu, w rozmowach, które mają już folder w archiwum;
- ponawianie plików, których WhatsApp nie oddał za pierwszym razem;
- panel dostępny wyłącznie z sieci lokalnej;
- deduplikacja na podstawie identyfikatorów WhatsAppa;
- obsługa wiadomości z zabezpieczonych czatów;
- automatyczne ponowienie pracy po przejściowym rozłączeniu lub awarii;
- retencja, czyli opcjonalne usuwanie starych wiadomości i mediów;
- opcjonalny prywatny asystent `?tau` z formularzem w panelu;
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

## Prywatny asystent `?tau`

Funkcja jest domyślnie wyłączona. Włącza się ją świadomie w głównym `.env`:

```dotenv
TAU_ENABLED=true
```

Providerem jest zwykły chat WhatsApp z numerem `+1 800 242 8478`. Po starcie logger sprawdza przez `getNumberId()`, czy bieżąca sesja widzi ten numer. Przykład polecenia wysłanego przez właściciela w rozmowie:

```text
?tau o czym ostatnio rozmawialiśmy?
```

Logger przekazuje wyłącznie ostatnie maksymalnie 200 wiadomości typu tekstowego z tej rozmowy. Pomija multimedia, wcześniejsze polecenia `?tau`, wcześniejsze odpowiedzi `[TAU]` i inne czaty.

Odpowiedź wraca tam, gdzie padło polecenie: `?tau` wpisane w rozmowie z kimś odsyła wiadomość `[TAU]` do tej samej rozmowy, więc widzi ją również rozmówca. Błędy, podpowiedzi i niejednoznaczne dopasowania idą zawsze do własnego chatu właściciela, nigdy do rozmówcy. Polecenie zadane we własnym chacie zostaje w nim razem z odpowiedzią.

Wiadomość z `?tau` wysłana przez inną osobę zostaje tylko zarchiwizowana. Backend wymaga jednocześnie `message.fromMe === true` oraz `message.id.fromMe === true`. Własne wiadomości generowane przez aplikację są dodatkowo oznaczane i nie mogą uruchomić parsera ponownie.

Z własnego chatu można wskazać inną rozmowę numerem albo nazwą:

```text
?tau +48123456789 o czym ostatnio rozmawialiśmy?
?tau Natalia podsumuj ostatnie ustalenia
```

Wyszukiwanie najpierw sprawdza dokładny numer i nazwę, potem wariant bez wielkości liter i ozdobników, a na końcu ostrożne dopasowanie przybliżone. Niejednoznaczny wynik nie wysyła żadnego kontekstu do providera.

Na stronie rozmowy w panelu jest ten sam asystent. Chroniony sesją endpoint zapisuje do kolejki tylko identyfikator folderu i pytanie. Wspólny proces loggera buduje kontekst w pamięci i wykonuje zapytanie; panel pokazuje stany wysyłania, oczekiwania, odpowiedzi i błędu.

Ważne ograniczenia:

- numer WhatsApp nie jest API i nie obsługuje prawdziwych ról `system`, `user` i `assistant`;
- centralna instrukcja bezpieczeństwa jest wysyłana jako zwykły tekst, a nie jako techniczny system prompt;
- requesty są wykonywane pojedynczo, a odpowiedź musi zawierać unikalny marker konkretnego zapytania; wiadomości bez markera są ignorowane;
- nie ma technicznej gwarancji, że provider nie wykorzysta własnej wcześniejszej historii chatu. Każdy request zawiera pełny bieżący kontekst i polecenie ignorowania starej historii, ale jest to izolacja best-effort;
- polecenie wpisane w zwykłej rozmowie zostało już wysłane rozmówcy, zanim `message_create` dotrze do loggera, a odpowiedź `[TAU]` trafia do tej samej rozmowy. Do całkowicie prywatnych pytań użyj własnego chatu albo panelu;
- awaria i timeout AI nie zatrzymują archiwizacji. Po restarcie przerwanego zadania panel nie wysyła kontekstu ponownie automatycznie.

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

Po połączeniu logger przegląda ostatnie wiadomości dostępne w WhatsApp Web. Domyślnie zaczyna od 250 pozycji. Jeżeli nie znajdzie zapisanego checkpointu, stopniowo pogłębia okno, maksymalnie do 50 000 wiadomości, zamiast skanować całą historię od początku.

Zwykły start obejmuje **wyłącznie** czaty, które mają już swój folder w `logs/`. Rozmowy bez folderu są pomijane i pokazują się w podsumowaniu jako „pominiętych czatów bez folderu"; do ich założenia służy `--nadrob-wszystko`. Dotyczy to także pierwszego uruchomienia na pustym archiwum - pełną historię pobiera wtedy dopiero jawne polecenie, a nie sam start.

WhatsApp trzyma dziś tę samą rozmowę pod dwoma identyfikatorami: numerem telefonu i `@lid`. Historię da się odczytać tylko tym, który bieżąca sesja ma w swoim `Store` - dla drugiego `WWebJS.getChat()` schodzi do `findOrCreateLatestChat()` i oddaje świeżo utworzony, pusty czat. Nadrabianie widziało wtedy zero wiadomości, kończyło się bez błędu i luka po przerwie nie zamykała się już nigdy. Dlatego identyfikatory tej samej rozmowy są grupowane po folderze archiwum, czytanie zaczyna się od tego, który zna strona, a pusty wynik nie kończy sprawy - próbowany jest kolejny alias.

Listę czatów logger czyta wprost z kolekcji `Store` w stronie WhatsApp Web. Zbiorcze `getChats()` i pojedyncze `getChatById()` serializują cały model czatu i potrafią odrzucić wywołanie błędem `r: r` przez jedną wadliwą grupę - wtedy nadrabianie nie miało czego przejrzeć. Publiczne API zostaje planem awaryjnym. Do listy zawsze dokładane są rozmowy ze spisu `logs/_czaty.json`, nawet jeżeli bieżąca sesja nie ma ich jeszcze w `Store`.

Historia jednego czatu ma trzy niezależne drogi odczytu: paczkowy odczyt ze `Store` bez modelu czatu, publiczne `getChatById()` oraz - gdy obie zawiodą - wiadomości tego czatu wprost z kolekcji `Store.Msg`. Ostatnia droga daje mniej niż pełne okno nadrabiania, ale nie wymaga modelu czatu, więc czat nie wypada z przeglądu w całości. Powód porażki pierwszych trzech czatów trafia wprost do konsoli, a nie tylko do `logs/_bledy.json`.

O tym, czy wiadomość jest nowa, decyduje wyłącznie jej identyfikator. Checkpoint mówi tylko, jak głęboko sięgnąć po historię, i nie odcina niczego po znaczniku czasu - inaczej wiadomość dosłana z opóźnieniem, z datą starszą niż ostatnia zapisana, nie trafiłaby do archiwum już nigdy.

Aby świadomie przeskanować wszystkie czaty widoczne dla sesji i utworzyć foldery także dla wcześniej niearchiwizowanych rozmów, uruchom:

```powershell
npm start -- --nadrob-wszystko
```

To polecenie działa jednorazowo: nie uruchamia panelu i kończy pracę po zapisaniu znalezionych wiadomości. Pobiera listę wszystkich czatów widocznych dla sesji, również nieznanych lokalnie, a dodatkowo każdą osobę z książki adresowej tego konta - także taką, z którą rozmowa nie jest jeszcze otwarta w tej sesji. Dostępną historię przekazuje do loggera partiami po 250 modeli. Folder powstaje wyłącznie dla rozmów, w których faktycznie coś jest. Limit `BACKFILL_MESSAGES_PER_CHAT` dotyczy tylko zwykłej synchronizacji przyrostowej.

Najpierw wykorzystywany jest stabilny identyfikator nadany przez WhatsApp. Jeżeli wyjątkowo go brakuje, aplikacja tworzy deterministyczny identyfikator zastępczy z czasu i skrótu danych wiadomości. Dzięki temu ta sama wiadomość odebrana na żywo i znaleziona później podczas nadrabiania nie powinna pojawić się dwa razy.

Lista ostatnio widzianych identyfikatorów i ostatni poprawny checkpoint znajdują się w `_state.json` danego czatu. Checkpoint jest zapisywany dopiero po trwałym zapisie pobranej paczki. Nie należy ręcznie usuwać tego pliku podczas działania aplikacji.

Co 15 minut logger wykonuje lekką kontrolę przyrostową znanych czatów. Nie uruchamia dwóch przebiegów równolegle. Odstęp ustawia `SYNC_INTERVAL_MINUTES`, a `0` wyłącza wyłącznie kontrole okresowe.

Pełne nadrabianie oznacza całą historię udostępnioną bieżącej sesji WhatsApp Web, nie gwarancję całej historii konta z telefonu. `whatsapp-web.js` musi najpierw załadować tę historię do swojej strony Chromium; logger odbiera ją później partiami i nie trzyma jednocześnie wszystkich obiektów wiadomości w procesie Node.

## Pliki, których WhatsApp nie oddał od razu

WhatsApp odmawia wydania pliku z powodów przejściowych: media wygasły na serwerze i czekają, aż telefon wyśle je ponownie (`REUPLOADING`), pobieranie dopiero ruszyło (`FETCHING`) albo łącze przycięło je w połowie. Wiadomość zostaje wtedy w archiwum z notatką w rodzaju „Nie zapisano pliku: zdjęcie, 102 KB. Powód: nie udało się pobrać pliku".

Logger próbuje temu zapobiec na dwa sposoby. Przy zapisie czeka w przeglądarce na zakończenie pobierania zamiast poprzestawać na pustej odpowiedzi, prosi telefon o ponowne wysłanie wygasłego pliku i szuka wiadomości także przez `getMessagesById`, gdy nie ma jej już w pamięci strony.

Jeżeli mimo to plik nie przyszedł, wiadomość trafia do `logs/_media_do_pobrania.json`. Przy każdym przeglądzie (`SWEEP_CHECK_HOURS`, domyślnie co 6 godzin) logger wraca do takich wiadomości, a po udanym pobraniu podmienia notatkę na plik w `messages_XXXX.json`, w odpowiadającym mu pliku HTML i w bazie. Odzyskane pliki są zliczane w konsoli:

```text
Zaległe pliki: odzyskano 2 z 5, czeka jeszcze 3.
```

Do jednej wiadomości logger wraca najwyżej osiem razy i nie dłużej niż przez 14 dni - po tym czasie plik na pewno wygasł po stronie WhatsAppa i notatka zostaje na stałe. Notatki o plikach pominiętych świadomie (wyłączony typ, przekroczony `MAX_MEDIA_SIZE_MB`) do kolejki nie trafiają.

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

Relacje są czytane wprost z kolekcji `Store.Status`. `getBroadcasts()` z biblioteki składa je z `status.serialize()`, a nowsze wydania WhatsApp Weba potrafią oddać relację bez listy wiadomości - przegląd nie miał wtedy czego dopisać. Publiczne API zostaje planem awaryjnym.

Skasowanie relacji z archiwum znaczy „pobierz ją jeszcze raz". Gdy folderu albo `_state.json` już nie ma, logger zapomina ten czat i przy najbliższym przeglądzie zapisuje relację od nowa - o ile WhatsApp nadal ją pokazuje, bo relacja żyje dobę.

### Panel, baza i integracje

| Zmienna | Domyślnie | Znaczenie |
|---|---:|---|
| `PANEL_ENABLED` | `true` | Uruchamia panel razem z loggerem. |
| `PANEL_HOST` | `127.0.0.1` | Adres nasłuchiwania panelu. |
| `PANEL_PORT` | `3000` | Port panelu. |
| `PANEL_LAN_ONLY` | `true` | Wpuszcza do panelu wyłącznie klientów z sieci lokalnej. |
| `PANEL_ALLOWED_IPS` | puste | Dodatkowe adresy albo zakresy CIDR spoza sieci prywatnych, po przecinku. |
| `TAU_ENABLED` | `false` | Włącza polecenie `?tau` i formularz w panelu. |
| `TAU_PROVIDER_NUMBER` | `18002428478` | Numer providera zapisany wyłącznie cyframi. |
| `TAU_TIMEOUT_SECONDS` | `120` | Limit oczekiwania na oznaczoną odpowiedź. |
| `TAU_MAX_MESSAGES` | `200` | Maksymalna liczba tekstowych wiadomości w kontekście, nie więcej niż 200. |
| `TAU_MAX_CONTEXT_CHARS` | `40000` | Dodatkowy limit znaków kontekstu w jednym requeście. |
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

### Dostęp do panelu tylko z sieci lokalnej

`PANEL_HOST=127.0.0.1` udostępnia panel wyłącznie na bieżącym komputerze. Ustawienie `0.0.0.0` albo adresu LAN wystawia go na sieć.

Sam adres nasłuchiwania nie wystarcza, gdy router przekazuje ruch z internetu na tę maszynę - przy DMZ albo przekierowaniu portu połączenie z internetu trafia na dokładnie ten sam adres LAN, na którym stoi panel. Nie wystarcza też nagłówek `X-Forwarded-For`: Next.js ustawia go tylko wtedy, gdy klient sam go nie przysłał, a przysłać może go każdy.

Dlatego przy `PANEL_LAN_ONLY=true` (domyślnie) panel Next.js nasłuchuje na `127.0.0.1`, a na `PANEL_HOST:PANEL_PORT` staje bramka, która sprawdza adres drugiego końca połączenia TCP - jedyną wartość, której klient nie ustawia. Z zewnątrz widać wyłącznie bramkę, a ta odpowiada wtedy kodem 403.

Przepuszczane są adresy `10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `169.254.x` oraz ich odpowiedniki w IPv6 (`::1`, `fc00::/7`, `fe80::/10`). Adresy spoza tych zakresów - na przykład VPN Tailscale, który używa `100.64.0.0/10` - dopisuje się do `PANEL_ALLOWED_IPS`:

```dotenv
PANEL_HOST=0.0.0.0
PANEL_PORT=7777
PANEL_LAN_ONLY=true
PANEL_ALLOWED_IPS=100.64.0.0/10
```

Bramka działa tylko przy uruchomieniu przez `npm start`. `npm run panel` startuje sam Next.js, bez niej. Hasło do panelu obowiązuje niezależnie od bramki - to dwie osobne warstwy.

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
├── _tau/
│   ├── requests/
│   ├── processing/
│   └── results/
├── _czaty.json
├── _media_do_pobrania.json
├── _bledy.json
└── _kasowanie.log
```

- `messages_XXXX.html` to gotowe do czytania części rozmowy;
- `messages_XXXX.json` zawierają te same partie dla panelu;
- `_state.json` przechowuje jeszcze niezamkniętą partię i identyfikatory do deduplikacji;
- `_czaty.json` mapuje identyfikatory WhatsAppa na foldery archiwum;
- `_media_do_pobrania.json` to lista plików czekających na ponowne pobranie;
- `_tau` zawiera krótkotrwałą kolejkę panelu bez kopii kontekstu rozmowy;
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
| Nie pojawia się kod QR | Kod jest drukowany w terminalu także przy `HEADLESS=true`. Po `LOGOUT` logger czeka na nowe parowanie bez restartu. Jeśli sesja została wcześniej przerwana w połowie wylogowania, zatrzymaj program, usuń tylko `.wwebjs_auth` i uruchom go ponownie. Archiwum `logs/` pozostaje bez zmian. |
| Chrome nie jest wykrywany | Ustaw pełną ścieżkę w `CHROME_PATH`. |
| Sesja straciła autoryzację | Przy `LOGOUT` poczekaj na QR w tym samym terminalu. Ręcznie usuń `.wwebjs_auth` tylko wtedy, gdy starsza wersja programu zostawiła niedokończoną sesję. |
| Folder czatu ma nazwę złożoną z cyfr | Poczekaj na synchronizację kontaktów; po znalezieniu lepszej nazwy logger potrafi przenieść archiwum. |
| Grupa ma w archiwum sam identyfikator zamiast nazwy | Temat grupy jest czytany wprost ze `Store` - z modelu czatu, a gdy go brakuje, z `GroupMetadata`. `getChat()`, który dla grupy bez metadanych kończył się błędem `r: r`, jest tylko pierwszą z prób. Nazwa poprawia się przy kolejnej wiadomości albo przy najbliższym nadrabianiu, razem z przeniesieniem folderu. |
| Nie zapisuje się żadne zdjęcie profilowe | Adres miniatury jest brany z kolekcji `ProfilePicThumb`. Publiczne `getProfilePicUrl()` schodzi do `requestProfilePicFromServer()`, które w części wydań WhatsApp Weba kończy się `Cannot read properties of undefined (reading 'isNewsletter')` - teraz jest już tylko planem awaryjnym i jego wyjątek nie przerywa pobierania. |
| Pojawia się komunikat o częściowych danych WhatsApp Web | Zaktualizuj `whatsapp-web.js` i ponownie przetestuj aplikację. |
| Nadrabianie kończy się bez błędu, ale luka z czasu przerwy zostaje | WhatsApp trzyma tę samą rozmowę pod numerem telefonu i pod `@lid`, a historię oddaje tylko temu identyfikatorowi, który ma w `Store`. Drugi zakłada w locie pusty czat i nadrabianie wracało z zerem wiadomości. Teraz identyfikatory jednej rozmowy są grupowane po folderze archiwum, czytanie zaczyna się od znanego stronie, a pusty wynik kieruje do kolejnego aliasu. |
| Zbiorcze pobranie czatów kończy się krótkim błędem `r: r` | Lista czatów i historia są czytane wprost z `Store`, z pominięciem serializacji modeli, która ten błąd wywołuje. Publiczne `getChats()` i `getChatById()` są używane dopiero jako plan awaryjny, a spis `logs/_czaty.json` jako ostatni. Zakres, którego nie udało się objąć, jest oznaczany jako niepełny, a liczba pominiętych czatów pojawia się w podsumowaniu. |
| W archiwum jest notatka „nie udało się pobrać pliku" | Pobranie jest ponawiane, bo WhatsApp Web oddaje pustkę również w trakcie ściągania. Zanim logger sięgnie po `DownloadManager`, próbuje wziąć gotowy, rozszyfrowany plik, który przeglądarka trzyma po udanym pobraniu - ta droga nie potrzebuje `directPath` ani `mediaKey`, których wygasłe media czasem już nie mają. Pliku z relacji sprzed doby albo z bezpowrotnie wygasłego załącznika nie odzyska już nikt - notatka zostaje w archiwum wraz z typem i rozmiarem. |
| Zabezpieczony czat nie został odsłonięty | Nowe wiadomości nadal są zapisywane; WhatsApp Web może jedynie nie udostępnić wcześniejszej historii. |
| Panel nie startuje | Uruchom `npm run panel:build`, a potem ponownie `npm start`. |
| Panel pokazuje błąd konfiguracji | Sprawdź `AUTH_SECRET` w `panel/.env`. |
| Nie można zalogować się do panelu | `npm start -- --baza` sprawdzi bazę, a `npm start -- --uzytkownik <login>` ustawi hasło ponownie. Konsola panelu rozróżnia brak konta, niepasujące hasło i błąd SQL. |
| Panel widzi inny lub pusty folder | Sprawdź `LOGS_DIR`; launcher przekazuje panelowi ścieżkę używaną przez logger. |
| `?tau` jest wyłączone | Ustaw `TAU_ENABLED=true` w głównym `.env` i uruchom ponownie logger oraz panel. |
| `?tau` kończy się timeoutem | Provider nie zwrócił wymaganego markera. Sprawdź ręcznie, czy numer odpowiada w tej sesji WhatsApp. |
| Potrzebne są szczegóły awarii | Zajrzyj do `logs/_bledy.json` albo ustaw `LOG_LEVEL=debug`. |

## Uwagi

- Logger nie wywołuje `sendSeen` ani `markChatUnread`; pobieranie historii nie oznacza wiadomości jako przeczytanych. Ostateczne zachowanie samego WhatsApp Web może się jednak zmienić po jego aktualizacji.
- Aplikacja nie odzyska wiadomości, których WhatsApp Web nie udostępnia bieżącej sesji.
- Usunięcie danych sesji wymusza ponowne sparowanie urządzenia.
- Włączenie retencji oznacza rzeczywiste usuwanie starszych plików z lokalnego archiwum.
- Archiwizuj wyłącznie dane, do których masz prawo, i odpowiednio zabezpiecz kopie zapasowe.
