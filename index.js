// WhatsApp Logger – punkt startowy
// Uruchom: node index.js
// Przy pierwszym uruchomieniu zeskanuj kod QR w WhatsApp > Urządzenia połączone

'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode-terminal');
const fs      = require('fs');
const { Storage } = require('./src/storage');
const discord = require('./src/discord');

const storage = new Storage();

// ─────────────────────────────────────────────────────────────────────────────
//  Wykrywanie ścieżki Chrome / Chromium (Windows i Linux)
// ─────────────────────────────────────────────────────────────────────────────

function findChromePath() {
    const candidates = process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA
                ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
                : null,
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/google-chrome-beta',
          ];

    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    // Jeśli żadnej nie znaleziono – niech puppeteer sam zdecyduje (może mieć własną)
    return undefined;
}

const chromePath = findChromePath();
if (chromePath) {
    console.log(`Używam przeglądarki: ${chromePath}`);
} else {
    console.warn('Nie znaleziono Chrome/Chromium – puppeteer użyje domyślnej przeglądarki (może być wymagana instalacja).');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Klient WhatsApp Web
// ─────────────────────────────────────────────────────────────────────────────

const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',       // wymagane na Linuksie (mały /dev/shm na serwerach)
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
];

const puppeteerConfig = {
    headless: true,
    args: puppeteerArgs,
};

if (chromePath) {
    puppeteerConfig.executablePath = chromePath;
}

const client = new Client({
    // Sesja zapisywana lokalnie – nie trzeba skanować QR po każdym uruchomieniu
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    // Nie rozgłaszaj statusu "online" przy połączeniu – mniejsza widoczność dla rozmówców
    markOnlineOnConnect: false,
    puppeteer: puppeteerConfig,
});

// ─────────────────────────────────────────────────────────────────────────────
//  Zdarzenia klienta
// ─────────────────────────────────────────────────────────────────────────────

client.on('qr', (qr) => {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  Zeskanuj kod QR w aplikacji WhatsApp    ║');
    console.log('║  Ustawienia > Urządzenia połączone       ║');
    console.log('╚══════════════════════════════════════════╝\n');
    qrcode.generate(qr, { small: true });
    discord.notifyQrRequired().catch(() => {});
});

client.on('loading_screen', (percent, message) => {
    process.stdout.write(`\rŁadowanie: ${percent}% – ${message}          `);
    if (percent === 100) process.stdout.write('\n');
});

client.on('authenticated', () => {
    console.log('\n✓ Uwierzytelnienie pomyślne');
});

client.on('auth_failure', async (msg) => {
    console.error('\n✗ Błąd uwierzytelnienia:', msg);
    console.error('Usuń folder .wwebjs_auth i uruchom ponownie, aby zeskanować nowy QR.');
    await discord.notifyAuthFailure(msg).catch(() => {});
    process.exit(1);
});

client.on('ready', () => {
    console.log('✓ WhatsApp Logger uruchomiony – monitoruję wiadomości...\n');
    discord.notifyReady().catch(() => {});
});

client.on('disconnected', async (reason) => {
    console.warn('\nRozłączono:', reason);
    await discord.notifyDisconnected(reason).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
//  Odebrane wiadomości
// ─────────────────────────────────────────────────────────────────────────────

client.on('message', async (message) => {
    await storage.saveMessage(client, message);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Wysłane wiadomości (przez aktualnie zalogowanego użytkownika)
// ─────────────────────────────────────────────────────────────────────────────

client.on('message_create', async (message) => {
    // 'message_create' odpala się również dla odebranych, stąd filtr fromMe
    if (message.fromMe) {
        await storage.saveMessage(client, message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Usunięte wiadomości – zachowujemy treść zanim zniknie
// ─────────────────────────────────────────────────────────────────────────────

// Usunięcie "dla wszystkich" – mamy wersję 'before' (oryginał)
client.on('message_revoke_everyone', async (_after, before) => {
    if (before) {
        await storage.markDeleted(before);
    }
});

// Usunięcie "dla mnie" – mamy oryginalną wiadomość
client.on('message_revoke_me', async (message) => {
    await storage.markDeleted(message);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Graceful shutdown – zapisz oczekujące wiadomości przed wyjściem
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown() {
    console.log('\nZatrzymywanie... Zapisuję oczekujące wiadomości...');
    try {
        await storage.flushAll();
        await client.destroy();
    } catch (err) {
        console.error('Błąd podczas zamykania:', err.message);
    }
    process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ─────────────────────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────────────────────

console.log('Uruchamianie WhatsApp Logger...');
client.initialize();
