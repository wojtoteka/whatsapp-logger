// Konfiguracja WhatsApp Loggera
//
// Wartości wrażliwe (webhook, hasło do zablokowanych czatów) NIE są trzymane
// w tym pliku. Nadpisz je w src/config.local.js - plik jest w .gitignore,
// więc zostaje wyłącznie na Twojej maszynie. Wzór: src/config.local.example.js
// Alternatywnie możesz podać je przez zmienne środowiskowe (mają pierwszeństwo).

const defaults = {
    // Ile wiadomości w jednym pliku HTML (potem zaczyna się nowy plik)
    MESSAGES_PER_FILE: 70,

    // Maksymalny rozmiar pobieranych mediów (zdjęcia, filmy) w MB
    MAX_MEDIA_SIZE_MB: 100,

    // Folder, do którego zapisywane są logi
    LOGS_DIR: './logs',

    // Typy wiadomości z mediami, które mają być pobierane
    // Dostępne typy: 'image', 'video', 'audio', 'document', 'sticker'
    MEDIA_TYPES: ['image', 'video', 'audio', 'sticker'],

    // Hasło do zablokowanych czatów WhatsApp (funkcja "Zablokowane czaty").
    // Uwaga: WhatsApp Web (a więc i ta biblioteka) ma dostęp do treści
    // zablokowanych czatów po zalogowaniu - nie wymaga osobnej weryfikacji.
    LOCKED_CHAT_PASSWORD: '',

    // URL webhooka Discord do powiadomień (błędy autoryzacji, rozłączenia).
    // Puste = powiadomienia wyłączone.
    DISCORD_WEBHOOK_URL: '',

    // ID użytkownika Discord do pingowania gdy wymagana jest interakcja (QR, błąd autoryzacji).
    // Puste = pingi wyłączone.
    DISCORD_PING_USER_ID: '',
};

// src/config.local.js jest opcjonalny - bez niego logger działa,
// tyle że bez powiadomień na Discordzie.
let local = {};
try {
    local = require('./config.local');
} catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

const fromEnv = {};
for (const key of ['LOCKED_CHAT_PASSWORD', 'DISCORD_WEBHOOK_URL', 'DISCORD_PING_USER_ID']) {
    if (process.env[key]) fromEnv[key] = process.env[key];
}

module.exports = { ...defaults, ...local, ...fromEnv };
