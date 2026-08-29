# WhatsApp Logger

Narzędzie archiwizujące własne rozmowy z WhatsAppa do przeglądalnych plików HTML. Loguje się przez WhatsApp Web (kod QR, jak przy zwykłym parowaniu urządzenia), nasłuchuje wiadomości i zapisuje je lokalnie razem z mediami.

> **Projekt edukacyjny, do własnego archiwum.** Logger widzi wyłącznie konwersacje konta, którym się zalogujesz. Zanim go użyjesz, upewnij się, że masz prawo archiwizować dane rozmowy - w wielu jurysdykcjach zapisywanie cudzych wiadomości bez wiedzy rozmówcy jest problematyczne prawnie.

## Uruchomienie

```bash
npm install
cd panel && npm install && cd ..     # zależności panelu
cp .env.example .env                 # konfiguracja loggera
cp panel/.env.example panel/.env     # konfiguracja panelu
cd panel && npx auth secret && cd .. # klucz do podpisywania sesji
npm start
```

Panel jest zamknięty na hasło, a konta siedzą w MariaDB. Zanim pierwszy raz się zalogujesz:

```bash
# 1. w konsoli MariaDB, raz:
#    CREATE DATABASE whatsapp_logger CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
#    CREATE USER 'whatsapp'@'localhost' IDENTIFIED BY 'twoje_haslo';
#    GRANT ALL PRIVILEGES ON whatsapp_logger.* TO 'whatsapp'@'localhost';

# 2. uzupełnij DB_* w .env oraz w panel/.env, potem:
npm start -- --baza          # sprawdza połączenie i zakłada tabele
npm start -- --uzytkownik    # zakłada konto (hasło pytane, niewidoczne)
```

`npm start` uruchamia **logger i panel razem**. Przy pierwszym starcie w terminalu pojawi się kod QR - zeskanuj go w telefonie: **WhatsApp → Urządzenia połączone → Połącz urządzenie**. Sesja zostaje zapamiętana, więc kolejne uruchomienia nie wymagają skanowania.

Panel otwiera się pod **http://localhost:3000** i czyta ten sam folder `logs`, do którego pisze logger - ścieżka jest przekazywana wprost, więc nie da się ich rozjechać.

Domyślnie nasłuchuje tylko na tej maszynie. Żeby wejść do niego z innego komputera w sieci, ustaw `PANEL_HOST` w `.env` - `0.0.0.0` (wszystkie karty sieciowe) albo konkretny adres serwera, np. `192.168.1.29`. Na maszynie z publicznym IP `0.0.0.0` wystawia archiwum na świat i jedyną ochroną zostaje hasło do logowania.

Przydatne polecenia:

```bash
npm start -- --sprawdz     # pokaż wczytane ustawienia i zakończ, bez łączenia
npm start -- --baza        # sprawdź połączenie z MariaDB i załóż tabele
npm start -- --uzytkownik  # załóż konto do panelu albo zmień mu hasło
npm run logger           # sam logger, bez panelu
npm run panel            # sam panel w trybie deweloperskim
npm test                 # zbuduj i uruchom testy
npm run typecheck        # sama kontrola typów
```

Zatrzymanie: `Ctrl+C`. Logger dopisuje wtedy do archiwum wszystko, co czekało w pamięci - launcher czeka, aż skończy, zanim zamknie proces.

## Konfiguracja

Wszystko siedzi w **jednym pliku `.env`** w katalogu programu. Wzór z komentarzami: [`.env.example`](.env.example). Pusta wartość albo brak linii oznacza ustawienie domyślne. Zmienna środowiskowa systemu ma pierwszeństwo przed plikiem.

| Ustawienie | Domyślnie | Co robi |
|---|---|---|
| `LOCKED_CHAT_PASSWORD` | *(puste)* | Kod do zablokowanych czatów. Puste = obsługa wyłączona. |
| `DISCORD_WEBHOOK_URL` | *(puste)* | Webhook powiadomień. Puste = powiadomienia wyłączone. |
| `DISCORD_PING_USER_ID` | *(puste)* | Kogo pingować przy utracie autoryzacji i przy kodzie QR. |
| `LOGS_DIR` | `./logs` | Folder archiwum. |
| `MESSAGES_PER_FILE` | `70` | Ile wiadomości mieści jeden plik HTML. |
| `MEDIA_TYPES` | wszystkie | `image,video,audio,ptt,document,sticker`. `brak` wyłącza pobieranie. |
| `MAX_MEDIA_SIZE_MB` | `100` | Plik ponad limit zostawia w archiwum notatkę zamiast pliku. |
| `SAVE_PROFILE_PICS` | `true` | Pobieranie zdjęć profilowych z historią zmian. |
| `AVATAR_REFRESH_DAYS` | `30` | Co ile dni sprawdzać, czy ktoś zmienił zdjęcie. |
| `SAVE_STATUSES` | `true` | Archiwizowanie relacji do `logs/Statusy/<autor>`. |
| `SWEEP_CHECK_HOURS` | `6` | Co ile godzin dobierać zaległe relacje i zdjęcia. |
| `RETENTION_ENABLED` | `true` | `false` = archiwum rośnie bez końca. |
| `RETENTION_DAYS` | `180` | Po ilu dniach znikają pliki HTML i media. |
| `RETENTION_CHECK_HOURS` | `12` | Co ile godzin sprawdzać, czy jest co skasować. |
| `PANEL_ENABLED` | `true` | Czy `npm start` ma uruchamiać też panel. |
| `PANEL_HOST` | `127.0.0.1` | Na czym panel nasłuchuje: `127.0.0.1` tylko ta maszyna, `0.0.0.0` wszystkie karty sieciowe, albo konkretne IP, np. `192.168.1.29`. Sam adres, bez `http://` i bez portu. |
| `PANEL_PORT` | `3000` | Port panelu. |
| `DB_ENABLED` | `false` | Zapis wiadomości do MariaDB (opcjonalny, panel go nie wymaga). |
| `DB_HOST` `DB_PORT` | `127.0.0.1` `3306` | Gdzie stoi baza. |
| `DB_USER` `DB_PASSWORD` `DB_NAME` | | Dane dostępowe i nazwa bazy. |
| `CHROME_PATH` | *(auto)* | Ścieżka do Chrome/Chromium, gdy wykrywanie zawiedzie. |
| `HEADLESS` | `true` | `false` pokazuje okno przeglądarki - przydatne przy diagnozie. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `STATE_SAVE_INTERVAL_MS` | `5000` | Minimalny odstęp między zapisami stanu czatu. |

Błędna wartość nie wywraca programu: zostaje przycięta albo zastąpiona domyślną, a przy starcie pojawia się o tym jedna linijka. Literówka w nazwie ustawienia też jest zgłaszana.

## Co robi

- **Archiwum w HTML** - wiadomości trafiają do gotowych do czytania plików, dzielonych po `MESSAGES_PER_FILE` na plik, w podfolderze per czat. Kolejne części łączą się odnośnikami tam i z powrotem.
- **Nazwa folderu: zapisany kontakt, nazwa profilu albo numer** - folder nazywa się tak, jak masz rozmówcę zapisanego w telefonie. Dla niezapisanego kontaktu używana jest jego nazwa profilu, potem numer telefonu, a cyfry z identyfikatora dopiero w ostateczności. Lepsza nazwa odnaleziona później przenosi razem folder, pliki HTML i media.
- **Pobieranie mediów** - zdjęcia, filmy, nagrania głosowe, dokumenty i naklejki lądują na dysku. Plik pominięty zostawia notatkę z typem, nazwą i rozmiarem, więc widać, że coś tam było.
- **Skasowane wiadomości zostają** - treść zachowuje się razem z notką „skasowana w WhatsAppie", także wtedy, gdy wiadomość trafiła już do zapisanego pliku HTML.
- **Zdjęcia profilowe z historią** - w `logs/_avatars/<kontakt>/<data>.jpg`. Gdy ktoś zmieni zdjęcie, dochodzi nowa wersja, a stara zostaje - dzięki temu stare wiadomości pokazują zdjęcie z tamtego czasu. Zdjęcia nie podlegają kasowaniu po czasie.
- **Relacje (statusy)** - w `logs/Statusy/<autor>`, osobno od rozmów. Na żywo zapisywane od razu, a przy starcie i co `SWEEP_CHECK_HOURS` program dobiera te, które WhatsApp ma jeszcze u siebie. Po identyfikatorze wiadomości poznaje, czego nie dopisywać drugi raz.
- **Lokalizacje, wizytówki, ankiety** - lokalizacja dostaje odnośnik do mapy, wizytówka rozkłada się na imię i numer, ankieta pokazuje pytanie z odpowiedziami.
- **Zabezpieczone czaty** - **archiwizują się zawsze, niezależnie od `LOCKED_CHAT_PASSWORD`.** Wiadomości zbieramy ze zdarzeń `message` i `message_create`, a te lecą również z czatów zablokowanych: blokada chroni interfejs, nie filtruje strumienia wiadomości. Logger nigdzie nie woła `getChats()`, więc nie ma czego odblokowywać, żeby czat trafił do logów. Kod z `.env` służy wyłącznie do odsłonięcia takich czatów w interfejsie tej sesji przeglądarki - przy `HEADLESS=true` nikt na niego nie patrzy, więc niepowodzenie nie jest awarią i konsola go tak nie zgłasza. Hasło ani lista czatów nie są nigdzie zapisywane.
- **Kasowanie po czasie** - stare pliki HTML i media znikają same, razem z wiadomościami, które utknęły w niedokończonej partii. Zdjęcia profilowe i pliki stanu zostają.
- **Powiadomienia na Discordzie** - o utracie autoryzacji, rozłączeniu i konieczności zeskanowania QR, z osobnym odstępem 5 minut dla każdej kategorii, żeby nie zasypać kanału. Odstęp jest zapisany na dysku, więc przeżywa restart.

## Panel

Osobna aplikacja w Next.js (TypeScript, React) w folderze `panel/`. Czyta archiwum **wprost z plików w `logs/`** - nie ma własnej bazy ani kopii danych, więc zawsze pokazuje to, co logger właśnie zapisał.

- **Rozmowy** - wszystkie czaty, od tego z najnowszą wiadomością. Kafelek pokazuje zdjęcie profilowe, podgląd ostatniej wiadomości i licznik.
- **Relacje** - osobna zakładka, autorzy relacji ułożeni tak samo.
- **Widok czatu** - wiadomości **od najnowszej**, po 60 na stronę, z separatorami dni. Starsze doczytuje się przyciskiem, a panel otwiera tylko te pliki partii, które są potrzebne na daną stronę.
- **Media** - zdjęcia, filmy, nagrania i dokumenty serwuje endpoint `/api/plik`, z obsługą zakresów (czyli filmy da się przewijać) i twardą blokadą wyjścia poza folder archiwum.

### Logowanie

Panel jest zamknięty: bez zalogowania każdy adres, łącznie z `/api/plik`, przekierowuje na stronę logowania. Obsługuje to [Auth.js](https://authjs.dev) (NextAuth v5) z sesją w podpisanym ciasteczku.

- **Konta** siedzą w MariaDB, w tabeli `panel_users`. Zakłada je logger: `npm start -- --uzytkownik`. Panel sam kont nie tworzy.
- **Hasła** są zapisane jako skrót `scrypt` (wbudowany w Node, bez bibliotek z kodem natywnym), z losową solą i porównaniem odpornym na pomiar czasu.
- **Klucz sesji** (`AUTH_SECRET`) siedzi w `panel/.env`. Jego zmiana wylogowuje wszystkich.
- Po zalogowaniu wracasz na stronę, którą próbowałeś otworzyć. Adres powrotu jest sprawdzany, więc nie da się przez niego przekierować na obcą witrynę.

Middleware chodzi w środowisku Edge, gdzie nie ma sterownika MariaDB - dlatego konfiguracja jest rozdzielona: [`auth.config.ts`](panel/auth.config.ts) sprawdza samo ciasteczko, a [`auth.ts`](panel/auth.ts) dokłada logowanie z bazą.

### Baza danych

Poza kontami logger może dopisywać do MariaDB także same wiadomości (`DB_ENABLED=true`) - przydaje się, gdy chcesz mieć archiwum w SQL-u albo szukać po treści (jest indeks pełnotekstowy). Do wyświetlania rozmów panel tego nie potrzebuje: czyta pliki.

## Struktura

```
index.ts              start, zdarzenia klienta, przeglądy cykliczne, zamykanie
scripts/uruchom.ts    wspólny start loggera i panelu
.env                  cała konfiguracja - NIE trafia do repozytorium
.env.example          wzór do skopiowania

src/config.ts         wczytanie i sprawdzenie .env
src/waClient.ts       przeglądarka, klient, czekanie na dane WhatsAppa
src/identity.ts       kto to jest: @lid → numer → nazwa, poziomy pewności
src/archive.ts        stan czatów, partie HTML, kolejka zapisu, zmiany nazw
src/html.ts           generowanie plików HTML
src/media.ts          pobieranie plików z wiadomości i z relacji
src/avatars.ts        zdjęcia profilowe z historią
src/statuses.ts       rozpoznawanie relacji
src/retention.ts      kasowanie plików starszych niż RETENTION_DAYS
src/lockedChats.ts    dostęp do czatów zabezpieczonych kodem
src/notify.ts         webhook Discorda z odstępem per kategoria
src/log.ts            konsola i plik z błędami
src/db.ts             MariaDB: konta panelu i opcjonalna kopia wiadomości
src/haslo.ts          skróty haseł (scrypt)
src/uzytkownicy.ts    zakładanie kont do panelu z wiersza poleceń
src/util.ts           nazwy plików, zapis na dysk, formatowanie
test/                 testy (node --test)

panel/.env            konfiguracja panelu - NIE trafia do repozytorium
panel/auth.config.ts  część Auth.js działająca w middleware (bez bazy)
panel/auth.ts         logowanie loginem i hasłem z MariaDB
panel/middleware.ts   bramka: bez sesji nie ma dostępu do niczego
panel/app/            strony: logowanie, rozmowy, relacje, czat, pliki
panel/lib/archiwum.ts czytanie archiwum z dysku
panel/components/     wiadomość, lista czatów, awatar
```

Kod jest w TypeScripcie, kompiluje się przez `tsc` do `dist/`. Zależności w czasie działania: [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) i `qrcode-terminal` - reszta to wbudowane moduły Node.

## Co powstaje w folderze archiwum

```
logs/
  Ala/
    messages_0001.html      kolejne części zapisu rozmowy
    media/                  pobrane zdjęcia, filmy, nagrania
    _state.json             partia, która jeszcze się nie zamknęła
  Statusy/
    Ala/                    relacje tej osoby, tak samo poukładane
  _avatars/
    48111222333@c.us/2026-08-29.jpg
    _historia.json          która wersja zdjęcia od kiedy obowiązuje
    messages_0001.json      ta sama partia w postaci danych - z niej czyta panel
  _czaty.json               gdzie leży archiwum którego czatu
  _bledy.json               ostatnie błędy, do diagnozy
  _kasowanie.log            co i kiedy skasowała retencja
```

## Prywatność

W `.gitignore` i nigdy w repozytorium:

| Ścieżka | Zawartość |
|---|---|
| `.env` | Hasło do zablokowanych czatów, webhook Discorda, dostęp do bazy |
| `panel/.env` | Klucz sesji panelu i dostęp do bazy |
| `logs/` | Zarchiwizowane rozmowy i pobrane media |
| `.wwebjs_auth/`, `.wwebjs_cache/` | Dane sesji WhatsAppa - dostęp do konta |

Dodatkowo hook `.githooks/pre-commit` zatrzyma commit z plikiem `.env`, z wypełnioną wartością wrażliwą w `.env.example` albo z adresem webhooka w dowolnym śledzonym pliku. Po świeżym klonie trzeba go włączyć, git nie robi tego sam:

```bash
git config core.hooksPath .githooks
```

Treść wiadomości jest escapowana przed wstawieniem do HTML, a nazwy czatów przechodzą przez własny sanitizer nazw plików - nazwa w rodzaju `../../gdzie indziej` nie założy folderu poza archiwum.

## Gdy coś nie działa

| Objaw | Co z tym zrobić |
|---|---|
| Foldery nazywają się samymi cyframi | WhatsApp Web nie zdążył wczytać książki adresowej. Program czeka na nią po połączeniu i sam przenosi foldery, gdy pozna lepszą nazwę - wystarczy dać mu chwilę. |
| `WhatsApp Web udostępnił dane tylko częściowo` | `whatsapp-web.js` jest starszy niż bieżąca wersja WhatsApp Weba. Pomaga `npm update whatsapp-web.js`. |
| Nie startuje przeglądarka | Wskaż ją w `CHROME_PATH` w `.env`. |
| Chcę zobaczyć, co się dzieje w przeglądarce | `HEADLESS=false` w `.env`. |
| Sesja wygasła | Usuń folder `.wwebjs_auth` i uruchom ponownie, żeby zeskanować nowy kod QR. |
| `Zabezpieczone czaty: ...` (cokolwiek poza „odsłonięte") | **Nie jest to awaria i nie tracisz wiadomości** - zablokowane czaty archiwizują się niezależnie od tej próby. Dotyczy tylko widoczności w interfejsie sesji. Najczęstszy powód: WhatsApp nie przysłał kodu tajnego do tej sesji (synchronizuje go w kolekcji `regular_low`), więc `validateSecretCode` nie ma czego porównać. Jeśli zależy Ci na samym odsłonięciu: przełącz kod tajny w telefonie (Ustawienia → Prywatność → Blokada czatu) albo sparuj urządzenie od nowa. |
| Szczegóły błędów | `logs/_bledy.json`, a przy `LOG_LEVEL=debug` także w konsoli. |
| Panel nie startuje | `npm run panel:build` - zainstaluje zależności i zbuduje go od nowa. |
| Nie mogę się zalogować | `npm start -- --baza` sprawdzi połączenie i pokaże istniejące konta. Nowe: `npm start -- --uzytkownik`. |
| „Configuration" zamiast strony logowania | Brak `AUTH_SECRET` w `panel/.env` - wygeneruj: `cd panel && npx auth secret`. |
| Panel pokazuje puste archiwum | Sprawdź ścieżkę w komunikacie na stronie - musi wskazywać na ten sam folder co `LOGS_DIR`. |
| Panel nie pokazuje starszych rozmów | Wiadomości sprzed wersji 2.1 nie mają plików `messages_XXXX.json`. Zostają w HTML-u, panel ich nie zobaczy. |
