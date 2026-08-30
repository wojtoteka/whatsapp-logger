// Wspólna usługa ?tau dla poleceń z WhatsAppa i zadań panelu. Logger nadal
// zapisuje wiadomość jako pierwszy; awaria tej warstwy nie zatrzymuje archiwum.

import type { Config } from './config';
import type { Archive } from './archive';
import { chatIdOf } from './identity';
import { log } from './log';
import {
    conversationForChatId,
    listTauConversations,
    loadTauContext,
    normalizePhone,
    parseTauCommand,
    resolveTargetedTauCommand,
} from './tauContext';
import type { TauConversation } from './tauContext';
import { TauJobWorker } from './tauJobs';
import { sendText, WhatsAppTauProvider } from './tauProvider';
import type { WaClient, WaMessage } from './types';

export class TauService {
    private readonly provider: WhatsAppTauProvider;
    private readonly jobs: TauJobWorker;
    private ready = false;

    constructor(
        private readonly config: Config,
        private readonly client: WaClient,
        private readonly archive: Archive,
    ) {
        this.provider = new WhatsAppTauProvider(
            client,
            config.tauProviderNumber,
            config.tauTimeoutSeconds * 1000,
        );
        this.jobs = new TauJobWorker(config.logsDir, (folder, question) =>
            this.answerForFolder(folder, question),
        );
    }

    async start(): Promise<void> {
        if (!this.config.tauEnabled) {
            log.info('?tau: wyłączone (TAU_ENABLED=false).');
            return;
        }

        this.provider.start();
        this.ready = true;
        try {
            await this.jobs.start();
        } catch (error) {
            log.error('Nie udało się uruchomić kolejki panelu ?tau', error, {
                stage: 'tau job worker start',
            });
        }
        // Kontrola numeru nie opóźnia komunikatu gotowości loggera. Pierwsze
        // faktyczne zapytanie ponowi ją, jeżeli WhatsApp jeszcze się ładuje.
        void this.provider
            .checkAvailability()
            .then(() => {
                log.info(`?tau: provider +${this.config.tauProviderNumber} jest dostępny w WhatsAppie.`);
            })
            .catch((error: unknown) => {
                log.warn(`?tau: ${safeError(error)}`);
            });
    }

    async stop(): Promise<void> {
        this.ready = false;
        this.provider.stop();
        await this.jobs.stop();
    }

    async acceptIncoming(message: WaMessage): Promise<void> {
        if (!this.config.tauEnabled) return;
        try {
            await this.provider.acceptIncoming(message);
        } catch (error) {
            log.error('Błąd odbioru odpowiedzi ?tau', error, { stage: 'tau provider response' });
        }
    }

    /** Uruchamiane dopiero po zakończeniu zapisu wysłanej wiadomości. */
    async acceptOutgoing(message: WaMessage): Promise<void> {
        if (!this.config.tauEnabled || !this.ready) return;
        if (message.fromMe !== true || message.id?.fromMe !== true || message.type !== 'chat') return;
        if (this.provider.isGenerated(message)) return;

        const command = parseTauCommand(message.body);
        if (command === null) return;

        if (!command) {
            await this.safeSendOwner('[TAU]\nPodaj pytanie po prefiksie ?tau.');
            return;
        }

        const chatId = chatIdOf(message);
        if (!chatId) {
            await this.safeSendOwner('[TAU]\nNie udało się ustalić rozmowy dla tego polecenia.');
            return;
        }

        try {
            let conversation: TauConversation;
            let question = command;
            if (this.isSelfChat(chatId)) {
                const conversations = await this.availableConversations();
                const target = resolveTargetedTauCommand(command, conversations);
                if (target.status === 'ambiguous') {
                    const names = target.conversations.map((item) => item.name).join(', ');
                    await this.safeSendOwner(
                        `[TAU]\nZnalazłem kilka pasujących rozmów: ${names}. ` +
                            'Podaj dokładniejszą nazwę albo numer telefonu.',
                    );
                    return;
                }
                if (target.status === 'invalid') {
                    await this.safeSendOwner(`[TAU]\n${target.message}`);
                    return;
                }
                conversation = target.conversation;
                question = target.question;
            } else {
                const found = await conversationForChatId(this.config.logsDir, chatId);
                if (!found || this.isProviderConversation(found)) {
                    await this.safeSendOwner('[TAU]\nNie znaleziono lokalnego archiwum tej rozmowy.');
                    return;
                }
                conversation = found;
            }

            const answer = await this.answerForFolder(conversation.folder, question);
            await this.safeSendOwner(`[TAU]\nRozmowa: ${conversation.name}\n\n${answer}`);
        } catch (error) {
            log.error('Błąd zapytania ?tau', error, { stage: 'tau command' });
            await this.safeSendOwner(`[TAU]\nNie udało się uzyskać odpowiedzi: ${safeError(error)}`);
        }
    }

    async answerForFolder(folder: string, question: string): Promise<string> {
        if (!this.config.tauEnabled || !this.ready) {
            throw new Error('?tau jest wyłączone albo logger nie jest jeszcze gotowy.');
        }
        const cleanQuestion = question.trim();
        if (!cleanQuestion) throw new Error('Pytanie nie może być puste.');
        if (cleanQuestion.length > 4000) throw new Error('Pytanie jest zbyt długie (maksymalnie 4000 znaków).');

        const conversation = (await this.availableConversations()).find((item) => item.folder === folder);
        if (!conversation) throw new Error('Nie znaleziono wskazanej rozmowy w lokalnym archiwum.');

        const context = await loadTauContext(this.config.logsDir, conversation.folder, {
            maxMessages: this.config.tauMaxMessages,
            maxChars: this.config.tauMaxContextChars,
            pendingMessages: this.archive.pendingMessagesFor(conversation.folder),
        });

        // To jedyne miejsce, w którym prywatny kontekst opuszcza aplikację.
        // Provider dostaje go w pamięci procesu, bez dodatkowego pliku i logu.
        return await this.provider.ask(cleanQuestion, context);
    }

    private async availableConversations(): Promise<TauConversation[]> {
        return (await listTauConversations(this.config.logsDir)).filter(
            (conversation) => !this.isProviderConversation(conversation),
        );
    }

    private isProviderConversation(conversation: TauConversation): boolean {
        return conversation.ids.some(
            (id) => normalizePhone(id) === this.config.tauProviderNumber,
        );
    }

    private isSelfChat(chatId: string): boolean {
        const owner = this.ownerId();
        return chatId === owner || normalizePhone(chatId) === normalizePhone(owner);
    }

    private ownerId(): string {
        const owner = this.client.info?.wid?._serialized;
        if (!owner) throw new Error('WhatsApp nie udostępnił identyfikatora właściciela sesji.');
        return owner;
    }

    private async sendOwner(text: string): Promise<void> {
        // Brak modelu wysłanej wiadomości nie znaczy, że nie poszła -
        // szczegóły przy sendText().
        const sent = await sendText(this.client, this.ownerId(), text.slice(0, 55000));
        this.provider.rememberGenerated(sent);
    }

    private async safeSendOwner(text: string): Promise<void> {
        try {
            await this.sendOwner(text);
        } catch (error) {
            log.error('Nie udało się przekazać wyniku ?tau właścicielowi', error, {
                stage: 'tau owner response',
            });
        }
    }
}

function safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 500) || 'nieznany błąd';
}
