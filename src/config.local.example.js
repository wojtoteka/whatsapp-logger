// Skopiuj ten plik jako src/config.local.js i uzupełnij własnymi wartościami.
// config.local.js jest w .gitignore i nigdy nie trafia do repozytorium.
//
// Co tu wpiszesz, nadpisuje wartości domyślne z config.js. Możesz nadpisać
// dowolne ustawienie, nie tylko sekrety. Zostaw zakomentowane te, których
// nie zmieniasz, wtedy działa wartość domyślna.

module.exports = {
    // ── Sekrety ──────────────────────────────────────────────────────

    // Hasło do zablokowanych czatów WhatsApp (funkcja "Zablokowane czaty").
    LOCKED_CHAT_PASSWORD: '',

    // Discord > kanał > Edytuj kanał > Integracje > Webhooki > Nowy webhook > Kopiuj URL
    DISCORD_WEBHOOK_URL: '',

    // ID użytkownika Discord pingowanego przy błędach autoryzacji i kodzie QR.
    DISCORD_PING_USER_ID: '',

    // ── Kasowanie starych wiadomości ─────────────────────────────────

    // Po ilu dniach znikają pliki HTML, pobrane media i wiadomości
    // czekające w _state.json. Domyślnie 180.
    // RETENTION_DAYS: 365,

    // false = nic się nie kasuje, archiwum rośnie bez końca.
    // RETENTION_ENABLED: false,

    // Co ile godzin program sprawdza, czy jest co skasować. Domyślnie 12.
    // Pierwsze sprawdzenie leci zaraz po połączeniu z WhatsAppem.
    // RETENTION_CHECK_HOURS: 24,

    // ── Media ────────────────────────────────────────────────────────

    // Typy wiadomości, których pliki mają lądować na dysku.
    // Do wyboru: 'image', 'video', 'audio', 'ptt' (nagranie głosowe),
    // 'document', 'sticker'. Domyślnie wszystkie.
    // Uwaga: dokumenty i filmy potrafią zająć dużo miejsca.
    // MEDIA_TYPES: ['image', 'video', 'ptt'],

    // Plik większy niż tyle MB nie zostaje zapisany, ale w archiwum
    // pojawia się notatka z typem, nazwą i rozmiarem. Domyślnie 100.
    // MAX_MEDIA_SIZE_MB: 25,

    // Pobieranie zdjęć profilowych do logs/_avatars. Domyślnie true.
    // SAVE_PROFILE_PICS: false,

    // ── Pliki i wydajność ────────────────────────────────────────────

    // Ile wiadomości mieści jeden plik HTML. Domyślnie 70.
    // MESSAGES_PER_FILE: 200,

    // Folder z archiwum. Ścieżka względna liczy się od katalogu programu.
    // LOGS_DIR: 'D:/Archiwum/whatsapp',

    // Minimalny odstęp między zapisami _state.json w milisekundach.
    // Domyślnie 5000. Mniej znaczy częstszy zapis na dysk,
    // 0 znaczy zapis po każdej wiadomości.
    // STATE_SAVE_INTERVAL_MS: 15000,
};
