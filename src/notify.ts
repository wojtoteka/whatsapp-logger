// Powiadomienia na Discordzie przez webhook.
//
// Bez żadnej biblioteki - wystarczy wbudowany moduł https. Każda kategoria
// alertu ma własny cooldown zapisany na dysku, więc restart programu nie
// resetuje go i kanał nie dostaje serii tych samych komunikatów.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import type { Config } from './config';
import { log } from './log';

const COOLDOWN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10000;

export type AlertCategory = 'auth_failure' | 'disconnected' | 'qr' | 'ready';

/**
 * Odstępy między powiadomieniami, osobne dla każdej kategorii, zapisane
 * na dysku. Dzięki temu program uruchamiany w pętli przez menedżera
 * procesów nie zasypie kanału tym samym alertem.
 */
export class Cooldown {
    constructor(
        private readonly file: string,
        private readonly windowMs: number = COOLDOWN_MS,
    ) {}

    /**
     * Sprawdza i od razu zajmuje okno dla danej kategorii. true znaczy
     * "wolno wysłać" - drugie wywołanie w tym samym oknie da już false.
     */
    claim(category: string, now: number = Date.now()): boolean {
        const entries = this.read();
        const last = entries[category] ?? 0;
        if (now - last < this.windowMs) return false;

        entries[category] = now;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(entries), 'utf8');
        } catch {
            // Brak zapisu oznacza tylko, że odstęp nie przeżyje restartu.
        }
        return true;
    }

    private read(): Record<string, number> {
        try {
            const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (parsed && typeof parsed === 'object') return parsed as Record<string, number>;
        } catch {
            // Pierwszy start albo uszkodzony plik - zaczynamy od zera.
        }
        return {};
    }
}

interface EmbedOptions {
    title: string;
    description: string;
    color: number;
    ping?: boolean;
    category: AlertCategory;
}

export class Notifier {
    private readonly cooldown: Cooldown;

    constructor(private readonly config: Config) {
        this.cooldown = new Cooldown(path.join(config.logsDir, '_discord.json'));
    }

    /** Czy powiadomienia są w ogóle włączone. */
    get enabled(): boolean {
        return this.config.discordWebhookUrl.length > 0;
    }

    /** Sesja wygasła albo WhatsApp odrzucił uwierzytelnienie. */
    async authFailure(reason: string): Promise<void> {
        await this.send({
            title: '🔴 WhatsApp Logger - utrata autoryzacji',
            description:
                'Sesja wygasła lub wystąpił błąd uwierzytelnienia.\n\n' +
                `**Powód:** ${reason || 'nieznany'}\n\n` +
                'Usuń folder `.wwebjs_auth` i uruchom program, żeby zeskanować nowy kod QR.',
            color: 0xdc2626,
            ping: true,
            category: 'auth_failure',
        });
    }

    async disconnected(reason: string): Promise<void> {
        await this.send({
            title: '🟠 WhatsApp Logger - rozłączono',
            description: `Klient został rozłączony z serwerami WhatsApp.\n\n**Powód:** ${reason || 'nieznany'}`,
            color: 0xf97316,
            category: 'disconnected',
        });
    }

    async qrRequired(): Promise<void> {
        await this.send({
            title: '🟡 WhatsApp Logger - wymagany kod QR',
            description:
                'WhatsApp wygenerował nowy kod QR. Jest widoczny w terminalu, ' +
                'w którym działa logger. Zeskanuj go przez WhatsApp → Urządzenia połączone.',
            color: 0xeab308,
            ping: true,
            category: 'qr',
        });
    }

    async ready(): Promise<void> {
        await this.send({
            title: '🟢 WhatsApp Logger - połączono',
            description: 'Logger jest podłączony i archiwizuje wiadomości.',
            color: 0x16a34a,
            category: 'ready',
        });
    }

    // -- Wysyłka ----------------------------------------------------------

    private async send(options: EmbedOptions): Promise<void> {
        if (!this.enabled) return;
        if (!this.cooldown.claim(options.category)) return;

        const ping =
            options.ping === true && this.config.discordPingUserId
                ? `<@${this.config.discordPingUserId}>`
                : undefined;

        const payload = JSON.stringify({
            ...(ping ? { content: ping } : {}),
            embeds: [
                {
                    title: options.title,
                    description: options.description,
                    color: options.color,
                    timestamp: new Date().toISOString(),
                    footer: { text: 'WhatsApp Logger' },
                },
            ],
        });

        let url: URL;
        try {
            url = new URL(this.config.discordWebhookUrl);
        } catch {
            log.once('discord:url', 'Nieprawidłowy DISCORD_WEBHOOK_URL w .env - powiadomienia pominięte.');
            return;
        }

        await new Promise<void>((resolve) => {
            const request = https.request(
                {
                    hostname: url.hostname,
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                },
                (response) => {
                    // Odczytujemy odpowiedź, żeby zwolnić połączenie.
                    response.resume();
                    const status = response.statusCode ?? 0;
                    if (status < 200 || status >= 300) {
                        log.warn(`[Discord] odpowiedź HTTP ${status}`);
                    }
                    resolve();
                },
            );

            request.on('error', (err) => {
                log.warn(`[Discord] nie udało się wysłać powiadomienia: ${err.message}`);
                resolve();
            });
            request.setTimeout(TIMEOUT_MS, () => {
                request.destroy();
                log.warn('[Discord] przekroczony czas wysyłania powiadomienia');
                resolve();
            });

            request.write(payload);
            request.end();
        });
    }

}
