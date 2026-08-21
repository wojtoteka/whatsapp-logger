// Moduł odpowiedzialny za zapis wiadomości, mediów i generowanie HTML

const fs       = require('fs-extra');
const path     = require('path');
const sanitize = require('sanitize-filename');
const config   = require('./config');
const { generateHtml } = require('./htmlTemplate');

class Storage {
    constructor() {
        this.logsDir = path.resolve(config.LOGS_DIR);
        // chatId → stan czatu (nazwa, folder, bieżąca partia wiadomości, numer partii itd.)
        this.chatStates = new Map();
        fs.ensureDirSync(this.logsDir);
    }

    // ─────────────────────────────────────────────────────────────
    //  Główna metoda - zapis wiadomości
    // ─────────────────────────────────────────────────────────────

    async saveMessage(client, message) {
        try {
            // Pomijamy wiadomości systemowe / powiadomienia o szyfrowaniu
            // oraz inne typy które mogą powodować błędy
            const ignoredTypes = [
                'e2e_notification',
                'notification_template', 
                'call_log',
                'gp2',  // grupowe powiadomienia systemowe
                'broadcast_notification',
                'protocol'
            ];
            
            if (ignoredTypes.includes(message.type)) {
                return;
            }

            const chat = await message.getChat();
            if (!chat || !chat.id) {
                console.warn('Pominięto wiadomość - brak obiektu czatu');
                return;
            }
            
            const chatId   = chat.id._serialized;
            const chatName = chat.name || chat.id.user || chatId;

            if (!this.chatStates.has(chatId)) {
                await this._initChatState(chatId, chatName);
            }

            const state = this.chatStates.get(chatId);

            // Nazwa nadawcy
            let senderName = 'Nieznany';
            if (message.fromMe) {
                senderName = 'Ja';
            } else {
                try {
                    const contact = await message.getContact();
                    if (contact) {
                        senderName = contact.pushname || contact.name || contact.number || message.author || 'Nieznany';
                    } else {
                        senderName = message.author || message.from || 'Nieznany';
                    }
                } catch {
                    senderName = message.author || message.from || 'Nieznany';
                }
            }

            // Pobierz media (jeśli typ jest na liście i rozmiar w normie)
            let mediaPath = null;
            if (message.hasMedia && config.MEDIA_TYPES.includes(message.type)) {
                mediaPath = await this._downloadMedia(message, state);
            }

            // Cytowana wiadomość
            let quotedInfo = null;
            if (message.hasQuotedMsg) {
                try {
                    const q = await message.getQuotedMessage();
                    if (q) {
                        quotedInfo = {
                            sender: q.fromMe ? 'Ja' : (q.author || 'Nieznany'),
                            body:   q.body || '[Media]',
                        };
                    }
                } catch { /* ignore */ }
            }

            const msgData = {
                id:         message.id._serialized,
                timestamp:  message.timestamp,
                from:       senderName,
                fromMe:     message.fromMe,
                body:       message.body       || '',
                type:       message.type,
                mediaPath,
                caption:    message.caption    || null,
                isDeleted:  false,
                isForwarded: message.isForwarded || false,
                quotedMsg:  quotedInfo,
            };

            state.pendingMessages.push(msgData);
            state.totalMessages++;

            // Jeśli partia pełna - zrzuć do HTML
            if (state.pendingMessages.length >= config.MESSAGES_PER_FILE) {
                await this._flushBatch(chatId);
            } else {
                // Co każdą wiadomość zapisuj stan JSON, aby nie zgubić danych po awarii
                await this._saveStateJson(chatId);
            }

            const preview = (message.body || '[media]').substring(0, 60);
            console.log(`[${chatName}] ${message.fromMe ? '→' : '←'} ${senderName}: ${preview}`);

        } catch (err) {
            // Szczegółowe logowanie błędu dla debugowania
            console.error('Błąd saveMessage:', err.message);
            // Loguj tylko pierwszą linię stack trace (bez zaśmiecania konsoli)
            if (err.stack) {
                const stackLine = err.stack.split('\n')[1]?.trim();
                if (stackLine) console.error('  →', stackLine);
            }
            // Nieznany typ wiadomości - loguj do pliku aby można było zbadać
            if (err.message.includes('description') || err.message.includes('undefined')) {
                try {
                    const debugInfo = {
                        timestamp: new Date().toISOString(),
                        error: err.message,
                        messageType: message?.type || 'unknown',
                        hasMedia: message?.hasMedia || false,
                        hasQuoted: message?.hasQuotedMsg || false,
                    };
                    const debugLog = path.join(this.logsDir, '_error_debug.json');
                    const existing = fs.existsSync(debugLog) 
                        ? JSON.parse(fs.readFileSync(debugLog, 'utf8'))
                        : [];
                    existing.push(debugInfo);
                    // Zachowaj tylko ostatnie 50 błędów
                    const trimmed = existing.slice(-50);
                    fs.writeFileSync(debugLog, JSON.stringify(trimmed, null, 2), 'utf8');
                } catch { /* ignore debug logging errors */ }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Oznaczenie wiadomości jako usuniętej (message_revoke_*)
    // ─────────────────────────────────────────────────────────────

    async markDeleted(message) {
        if (!message) return;
        const msgId = message.id._serialized;

        for (const [chatId, state] of this.chatStates) {
            const found = state.pendingMessages.find(m => m.id === msgId);
            if (found) {
                found.isDeleted = true;
                await this._saveStateJson(chatId);
                console.log(`[Usunięta - zachowana] ${found.from}: ${found.body.substring(0, 60)}`);
                return;
            }
        }
        // Wiadomość mogła już trafić do zapisanego pliku HTML -
        // zapisujemy identyfikator, żeby był dostępny do ewentualnego przyszłego przetwarzania.
        await this._logDeletedId(msgId);
    }

    // ─────────────────────────────────────────────────────────────
    //  Zrzut wszystkich oczekujących partii (przy zamykaniu)
    // ─────────────────────────────────────────────────────────────

    async flushAll() {
        for (const chatId of this.chatStates.keys()) {
            await this._flushBatch(chatId);
        }
        console.log('Wszystkie oczekujące wiadomości zostały zapisane.');
    }

    // ─────────────────────────────────────────────────────────────
    //  Metody prywatne
    // ─────────────────────────────────────────────────────────────

    async _initChatState(chatId, chatName) {
        // Bezpieczna nazwa folderu
        let safeName = sanitize(chatName, { replacement: '_' }).replace(/\s+/g, '_').substring(0, 80);
        if (!safeName) safeName = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');

        const chatDir  = path.join(this.logsDir, safeName);
        const mediaDir = path.join(chatDir, 'media');
        await fs.ensureDir(chatDir);
        await fs.ensureDir(mediaDir);

        // Wczytaj poprzedni stan (jeśli program był uruchomiony wcześniej)
        const stateFile = path.join(chatDir, '_state.json');
        let saved = null;
        if (await fs.pathExists(stateFile)) {
            try { saved = await fs.readJson(stateFile); } catch { /* ignore */ }
        }

        this.chatStates.set(chatId, {
            name:            chatName,
            safeName,
            chatDir,
            mediaDir,
            batchNum:        saved ? saved.batchNum        : 1,
            totalMessages:   saved ? saved.totalMessages   : 0,
            pendingMessages: saved ? saved.pendingMessages : [],
        });
    }

    async _flushBatch(chatId) {
        const state = this.chatStates.get(chatId);
        if (!state || state.pendingMessages.length === 0) return;

        const filename = `messages_${String(state.batchNum).padStart(4, '0')}.html`;
        const filepath = path.join(state.chatDir, filename);

        const html = generateHtml({
            chatName:  state.name,
            batchNum:  state.batchNum,
            messages:  state.pendingMessages,
        });

        await fs.writeFile(filepath, html, 'utf8');
        console.log(`✓ Zapisano: ${filepath} (${state.pendingMessages.length} wiad.)`);

        state.batchNum++;
        state.pendingMessages = [];

        await this._saveStateJson(chatId);
    }

    async _saveStateJson(chatId) {
        const state = this.chatStates.get(chatId);
        const stateFile = path.join(state.chatDir, '_state.json');
        const data = {
            chatName:        state.name,
            batchNum:        state.batchNum,
            totalMessages:   state.totalMessages,
            pendingMessages: state.pendingMessages,
            lastUpdated:     new Date().toISOString(),
        };
        await fs.writeJson(stateFile, data, { spaces: 2 });
    }

    async _downloadMedia(message, state) {
        try {
            const media = await message.downloadMedia();
            if (!media || !media.data) return null;

            // Sprawdź rozmiar (base64 → bajty ≈ długość × 0,75)
            const sizeBytes = (media.data.length * 3) / 4;
            const sizeMB    = sizeBytes / (1024 * 1024);
            if (sizeMB > config.MAX_MEDIA_SIZE_MB) {
                console.log(`Pominięto plik - za duży: ${sizeMB.toFixed(1)} MB (limit: ${config.MAX_MEDIA_SIZE_MB} MB)`);
                return null;
            }

            // Wyznacz rozszerzenie z MIME
            const mime = media.mimetype || 'application/octet-stream';
            const ext  = mime.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg') || 'bin';

            const filename  = `${Date.now()}_${message.id.id.substring(0, 10)}.${ext}`;
            const absPath   = path.join(state.mediaDir, filename);

            await fs.writeFile(absPath, Buffer.from(media.data, 'base64'));

            // Zwróć ścieżkę względną (od folderu czatu) - do użycia w HTML
            return path.relative(state.chatDir, absPath);
        } catch (err) {
            console.error('Błąd pobierania mediów:', err.message);
            return null;
        }
    }

    async _logDeletedId(msgId) {
        const logFile = path.join(this.logsDir, '_deleted_ids.log');
        try {
            await fs.appendFile(logFile, `${new Date().toISOString()} ${msgId}\n`, 'utf8');
        } catch { /* ignore */ }
    }
}

module.exports = { Storage };
