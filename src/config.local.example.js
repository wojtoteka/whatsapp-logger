// Skopiuj ten plik jako src/config.local.js i uzupełnij własnymi wartościami.
// config.local.js jest w .gitignore i nigdy nie trafia do repozytorium.

module.exports = {
    // Hasło do zablokowanych czatów WhatsApp (funkcja "Zablokowane czaty").
    LOCKED_CHAT_PASSWORD: '',

    // Discord → kanał → Edytuj kanał → Integracje → Webhooki → Nowy webhook → Kopiuj URL
    DISCORD_WEBHOOK_URL: '',

    // ID użytkownika Discord pingowanego przy błędach autoryzacji / kodzie QR.
    DISCORD_PING_USER_ID: '',
};
