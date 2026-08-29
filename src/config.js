// Konfiguracja WhatsApp Loggera
//
// Wartości wrażliwe (webhook, hasło do zablokowanych czatów) NIE są trzymane
// w tym pliku. Nadpisz je w src/config.local.js - plik jest w .gitignore,
// więc zostaje wyłącznie na Twojej maszynie. Wzór: src/config.local.example.js
// Alternatywnie możesz podać je przez zmienne środowiskowe (mają pierwszeństwo).

const defaults = {
    // Ile wiadomości w jednym pliku HTML (potem zaczyna się nowy plik)
    MESSAGES_PER_FILE: 70,

    // Maksymalny rozmiar pobieranych mediów (zdjęcia, filmy) w MB.
    // Plik ponad limit nie jest zapisywany, ale w archiwum zostaje notatka
    // z nazwą, typem i rozmiarem, żeby było wiadomo, że coś tam było.
    MAX_MEDIA_SIZE_MB: 100,

    // Folder, do którego zapisywane są logi
    LOGS_DIR: './logs',

    // Typy wiadomości z mediami, które mają być pobierane.
    // Dostępne typy: 'image', 'video', 'audio', 'ptt' (nagranie głosowe),
    // 'document', 'sticker'
    MEDIA_TYPES: ['image', 'video', 'audio', 'ptt', 'document', 'sticker'],

    // Pobieranie zdjęć profilowych rozmówców do folderu media/_avatars.
    // Zdjęcia są pobierane raz na kontakt i nie podlegają kasowaniu po czasie.
    SAVE_PROFILE_PICS: true,

    // ── Kasowanie starych wiadomości ─────────────────────────────────
    // Po tylu dniach znikają pliki HTML z wiadomościami, pobrane media
    // i wiadomości oczekujące w _state.json. Ustaw 0, żeby nic nie kasować.
    RETENTION_DAYS: 180,

    // Włącznik kasowania. false = pliki zostają na zawsze.
    RETENTION_ENABLED: true,

    // Co ile godzin program sprawdza, czy jest co skasować.
    // Pierwsze sprawdzenie odpala się zaraz po połączeniu.
    RETENTION_CHECK_HOURS: 12,

    // ── Wydajność ────────────────────────────────────────────────────
    // Minimalny odstęp między zapisami _state.json (w milisekundach).
    // Chroni dysk przy ruchliwych grupach. Po awarii możesz stracić
    // wiadomości z tego okna, partie HTML zapisują się niezależnie.
    STATE_SAVE_INTERVAL_MS: 5000,

    // Wartości wrażliwe (hasło do zablokowanych czatów, webhook Discorda,
    // ID do pingowania) NIE mają tu swoich pól i nie wpisuj ich tutaj.
    // Ich miejsce to src/config.local.js, wzór w src/config.local.example.js.
    // Nieustawiony webhook oznacza po prostu powiadomienia wyłączone.
};

// src/config.local.js jest opcjonalny - bez niego logger działa,
// tyle że bez powiadomień na Discordzie.
let local = {};
try {
    local = require('./config.local');
} catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

const SECRETS = ['LOCKED_CHAT_PASSWORD', 'DISCORD_WEBHOOK_URL', 'DISCORD_PING_USER_ID'];

const fromEnv = {};
for (const key of SECRETS) {
    if (process.env[key]) fromEnv[key] = process.env[key];
}

// Ten plik trafia do repozytorium, więc sekret dopisany do defaults byłby
// wpadką. Hook .githooks/pre-commit blokuje taki commit, a poniższe
// ostrzeżenie łapie sytuację, gdy hook jest wyłączony albo pominięty.
const wSzablonie = SECRETS.filter(key => defaults[key]);
if (wSzablonie.length > 0) {
    console.warn('');
    console.warn('UWAGA: w src/config.js masz wpisane wartości wrażliwe:');
    console.warn(`       ${wSzablonie.join(', ')}`);
    console.warn('       Ten plik trafia do repozytorium. Przenieś je do src/config.local.js.');
    console.warn('');
}

module.exports = { ...defaults, ...local, ...fromEnv };
