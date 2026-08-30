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
        if (!active || message.fromMe || message.type !== 'chat') return false;

        let sender = chatIdOf(message);
        if (sender !== active.providerId) {
            try {
                const contact = await message.getContact();
                const number = typeof contact?.number === 'string' ? contact.number.replace(/\D/g, '') : '';
                if (number !== this.number) return false;
                sender = active.providerId;
            } catch {
                return false;
            }
        }
        if (sender !== active.providerId) return false;

        const parsed = parseProviderResponse(message.body, active.marker);
        if (!parsed.matched) return false;

        clearTimeout(active.timer);
        this.active = null;
        if (!parsed.answer) {
            active.reject(new Error('Provider ?tau zwrócił pustą odpowiedź po markerze.'));
        } else {
            active.resolve(parsed.answer);
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

    stop(): void {
        this.stopped = true;
        const active = this.active;
        if (!active) return;
        clearTimeout(active.timer);
        this.active = null;
        active.reject(new Error('Logger został zatrzymany podczas oczekiwania na odpowiedź ?tau.'));
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
            void this.client
                .sendMessage(providerId, prompt.text, {
                    sendSeen: false,
                    waitUntilMsgSent: true,
                })
                .then((sent) => {
                    if (!sent) throw new Error('WhatsApp nie potwierdził wysłania zapytania ?tau.');
                    this.rememberGenerated(sent as WaMessage);
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
