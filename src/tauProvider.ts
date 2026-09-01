// Provider ?tau oparty o zwykły chat z numerem ChatGPT. Nie traktujemy go
// jak API: requesty są szeregowane, a odpowiedź musi powtórzyć losowy marker.

import { randomUUID } from 'node:crypto';
import type { ContactId } from 'whatsapp-web.js';
import type { WaClient, WaMessage } from './types';
import type { TauContextMessage } from './tauContext';
import { chatIdOf, messageKey } from './identity';
import { buildProviderPrompt, parseProviderResponse } from './tauPrompt';

interface ActiveRequest {
    marker: string;
    providerId: string;
    resolve: (answer: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

/**
 * Wysyła tekst i zwraca model wysłanej wiadomości, o ile WhatsApp go oddał.
 *
 * Brak modelu NIE jest awarią. Z waitUntilMsgSent:true whatsapp-web.js
 * odczytuje model dopiero po potwierdzeniu wysyłki, przez
 * Store.Msg.get(nowyKlucz). WhatsApp zdąży w tym czasie podmienić klucz
 * wiadomości, więc odczyt trafia w pustkę i biblioteka zwraca undefined,
 * mimo że wiadomość poszła. Traktowanie tego jako błędu gubiło każdą
 * odpowiedź ?tau: request docierał do providera, a logger zdążył już
 * odrzucić własne oczekiwanie. Awarię zgłasza dopiero odrzucone
 * sendMessage().
 */
export async function sendText(
    client: WaClient,
    chatId: string,
    text: string,
): Promise<WaMessage | null> {
    const sent = await client.sendMessage(chatId, text, {
        sendSeen: false,
        waitUntilMsgSent: true,
    });
    return (sent as WaMessage | null) ?? null;
}

export class WhatsAppTauProvider {
    private providerId: string | null = null;
    private active: ActiveRequest | null = null;
    private tail: Promise<void> = Promise.resolve();
    private stopped = false;
    private readonly generatedMessageIds = new Set<string>();

    constructor(
        private readonly client: WaClient,
        private readonly number: string,
        private readonly timeoutMs: number,
    ) {}

    async checkAvailability(): Promise<string> {
        if (!/^\d{8,15}$/.test(this.number)) {
            throw new Error('Numer providera ?tau jest nieprawidłowy.');
        }
        const id = (await this.client.getNumberId(this.number)) as ContactId | null;
        const serialized = id?._serialized;
        if (!serialized) {
            throw new Error(`Numer +${this.number} nie jest dostępny dla tej sesji WhatsApp.`);
        }
        this.providerId = serialized;
        return serialized;
    }

    ask(question: string, context: readonly TauContextMessage[]): Promise<string> {
        const run = this.tail.then(
            () => this.askOne(question, context),
            () => this.askOne(question, context),
        );
        this.tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /** Wywoływane dla każdej odebranej wiadomości przed parserem ?tau. */
    async acceptIncoming(message: WaMessage): Promise<boolean> {
        const active = this.active;
        if (!active || message.fromMe) return false;
        if (!(await this.isFromProvider(message, active.providerId))) return false;

        // Załącznik nie ma jak nieść markera, więc parser nigdy go nie dopasuje.
        // Bez tej gałęzi obrazek od providera przechodził bokiem, a żądanie wisiało
        // aż do końca timeoutu - razem z całą kolejką następnych pytań.
        if (message.type !== 'chat') {
            this.settle(
                active,
                new Error(
                    `Provider ?tau odesłał załącznik (${message.type}) zamiast tekstu z markerem.`,
                ),
            );
            return true;
        }

        const parsed = parseProviderResponse(message.body, active.marker);
        if (!parsed.matched) return false;

        if (!parsed.answer) {
            this.settle(active, new Error('Provider ?tau zwrócił pustą odpowiedź po markerze.'));
        } else {
            this.settle(active, parsed.answer);
        }
        return true;
    }

    isGenerated(message: WaMessage): boolean {
        const id = messageKey(message);
        return id ? this.generatedMessageIds.delete(id) : false;
    }

    rememberGenerated(message: WaMessage | null | undefined): void {
        const id = messageKey(message ?? null);
        if (!id) return;
        this.generatedMessageIds.add(id);
        if (this.generatedMessageIds.size > 1000) {
            const oldest = this.generatedMessageIds.values().next().value as string | undefined;
            if (oldest) this.generatedMessageIds.delete(oldest);
        }
    }

    /** Pozwala użyć tej samej usługi po ponownym sparowaniu WhatsAppa. */
    start(): void {
        this.stopped = false;
        this.providerId = null;
    }

    stop(): void {
        this.stopped = true;
        const active = this.active;
        if (!active) return;
        clearTimeout(active.timer);
        this.active = null;
        active.reject(new Error('Logger został zatrzymany podczas oczekiwania na odpowiedź ?tau.'));
    }

    /**
     * Czy ta wiadomość przyszła od providera. WhatsApp potrafi podać inny
     * identyfikator rozmowy niż ten z getNumberId (np. @lid), więc przy
     * niezgodności pytamy jeszcze o numer kontaktu.
     */
    private async isFromProvider(message: WaMessage, providerId: string): Promise<boolean> {
        if (chatIdOf(message) === providerId) return true;
        try {
            const contact = await message.getContact();
            const number = typeof contact?.number === 'string' ? contact.number.replace(/\D/g, '') : '';
            return number === this.number;
        } catch {
            return false;
        }
    }

    /** Domyka oczekiwanie - odpowiedzią albo błędem - i zwalnia kolejkę. */
    private settle(active: ActiveRequest, result: string | Error): void {
        clearTimeout(active.timer);
        if (this.active === active) this.active = null;
        if (result instanceof Error) active.reject(result);
        else active.resolve(result);
    }

    private async askOne(
        question: string,
        context: readonly TauContextMessage[],
    ): Promise<string> {
        if (this.stopped) throw new Error('Provider ?tau jest zatrzymany.');
        const providerId = this.providerId ?? (await this.checkAvailability());
        const requestId = randomUUID().replace(/-/g, '');
        const prompt = buildProviderPrompt(requestId, question, context);

        return await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.active?.marker === prompt.marker) this.active = null;
                reject(new Error('Minął czas oczekiwania na oznaczoną odpowiedź providera ?tau.'));
            }, this.timeoutMs);
            timer.unref?.();

            this.active = { marker: prompt.marker, providerId, resolve, reject, timer };
            void sendText(this.client, providerId, prompt.text)
                .then((sent) => {
                    this.rememberGenerated(sent);
                })
                .catch((error: unknown) => {
                    if (this.active?.marker !== prompt.marker) return;
                    clearTimeout(timer);
                    this.active = null;
                    reject(error instanceof Error ? error : new Error(String(error)));
                });
        });
    }
}
