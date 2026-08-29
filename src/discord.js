// Powiadomienia Discord przez Webhook
// Nie wymaga żadnych dodatkowych bibliotek - używa wbudowanego modułu https

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const config = require('./config');

// Cooldown zapisywany na dysk - przeżywa restarty PM2
// Każda kategoria ma NIEZALEŻNY cooldown (1 powiadomienie na kategorię)
const COOLDOWN_MS    = 5 * 60 * 1000; // 5 minut
const COOLDOWN_FILE  = path.resolve(__dirname, '../.discord_cooldown.json');

function loadCooldowns() {
    try {
        if (fs.existsSync(COOLDOWN_FILE)) {
            return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
        }
    } catch { /* ignore */ }
    return {};
}

function saveCooldowns(data) {
    try {
        fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data), 'utf8');
    } catch { /* ignore */ }
}

function canSend(category) {
    const cooldowns = loadCooldowns();
    const last = cooldowns[category] || 0;
    return (Date.now() - last) >= COOLDOWN_MS;
}

function markSent(category) {
    const cooldowns = loadCooldowns();
    cooldowns[category] = Date.now();
    saveCooldowns(cooldowns);
}

/**
 * Wysyła wiadomość embed na Discord Webhook.
 * ping=true dodaje wzmiankę użytkownika z DISCORD_PING_USER_ID.
 * category - klucz cooldownu, NIEZALEŻNY dla każdego typu alertu.
 * Jeśli DISCORD_WEBHOOK_URL nie jest ustawiony - cicho pomija.
 */
async function notify(title, description, color = 0xff0000, ping = false, category = null) {
    const webhookUrl = config.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    // Sprawdź cooldown (per kategoria, persisted na dysku)
    if (category) {
        if (!canSend(category)) {
            console.log(`[Discord] Pomijam "${category}" - cooldown aktywny (5 min).`);
            return;
        }
        markSent(category);
    }

    const pingText = (ping && config.DISCORD_PING_USER_ID)
        ? `<@${config.DISCORD_PING_USER_ID}> `
        : '';

    const body = {
        content: pingText || undefined,
        embeds: [{
            title,
            description,
            color,
            timestamp: new Date().toISOString(),
            footer: { text: 'WhatsApp Logger' },
        }],
    };

    // content nie może być pustym stringiem - usuń klucz jeśli brak pinga
    if (!body.content) delete body.content;

    const payload = JSON.stringify(body);

    return new Promise((resolve) => {
        let url;
        try {
            url = new URL(webhookUrl);
        } catch {
            console.error('[Discord] Nieprawidłowy DISCORD_WEBHOOK_URL w src/config.local.js');
            return resolve();
        }

        const options = {
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };

        const req = https.request(options, (res) => {
            // Odczytaj odpowiedź żeby zwolnić połączenie
            res.resume();
            if (res.statusCode >= 200 && res.statusCode < 300) {
                console.log('[Discord] Powiadomienie wysłane.');
            } else {
                console.error(`[Discord] Błąd HTTP ${res.statusCode}`);
            }
            resolve();
        });

        req.on('error', (err) => {
            console.error('[Discord] Błąd wysyłania:', err.message);
            resolve();
        });

        req.setTimeout(10000, () => {
            req.destroy();
            console.error('[Discord] Timeout wysyłania powiadomienia.');
            resolve();
        });

        req.write(payload);
        req.end();
    });
}

// Gotowe funkcje do użycia w index.js

/** Sesja wygasła / błąd autoryzacji */
async function notifyAuthFailure(reason) {
    await notify(
        '🔴 WhatsApp Logger - utrata autoryzacji',
        `Sesja wygasła lub wystąpił błąd uwierzytelnienia.\n\n` +
        `**Powód:** ${reason || 'nieznany'}\n\n` +
        `Zaloguj się ponownie: usuń folder \`.wwebjs_auth\` i uruchom \`node .\` żeby zeskanować nowy QR.`,
        0xdc2626,
        true,
        'auth_failure',
    );
}

/** Rozłączenie z serwerami WhatsApp */
async function notifyDisconnected(reason) {
    await notify(
        '🟠 WhatsApp Logger - rozłączono',
        `Klient został rozłączony z serwerami WhatsApp.\n\n**Powód:** ${reason || 'nieznany'}`,
        0xf97316,
        false,
        'disconnected',
    );
}

/** Nowy QR - trzeba ponownie zeskanować */
async function notifyQrRequired() {
    await notify(
        '🟡 WhatsApp Logger - wymagany QR',
        `Sesja wygasła. Uruchom program lokalnie i zeskanuj nowy kod QR w WhatsApp → Urządzenia połączone.`,
        0xeab308,
        true,
        'qr',
    );
}

/** Ponowne połączenie po rozłączeniu */
async function notifyReady() {
    await notify(
        '🟢 WhatsApp Logger - połączono',
        `Logger jest podłączony i monitoruje wiadomości.`,
        0x16a34a,
        false,
        'ready',
    );
}

module.exports = { notifyAuthFailure, notifyDisconnected, notifyQrRequired, notifyReady };
