// Moduł odpowiedzialny za zapis wiadomości, mediów i generowanie HTML

const fs       = require('fs-extra');
const path     = require('path');
const https    = require('https');
const http     = require('http');
const sanitize = require('sanitize-filename');
const config   = require('./config');
const { generateHtml, NEXT_LINK_MARKER, buildNextLink } = require('./htmlTemplate');

// Zdjęcie profilowe pobieramy ponownie dopiero po tylu dniach
const AVATAR_MAX_AGE_DAYS = 30;

class Storage {
    constructor() {
        this.logsDir = path.resolve(config.LOGS_DIR);
        // chatId → stan czatu (nazwa, folder, bieżąca partia wiadomości, numer partii itd.)
        this.chatStates = new Map();
        // chatId → ogon łańcucha promisów, dzięki temu jeden czat obsługujemy po kolei
        this.queues = new Map();
        // id kontaktu → nazwa, żeby nie odpytywać WhatsAppa o to samo w kółko
        this.contactNames = new Map();
        // id kontaktu → ścieżka do zdjęcia profilowego (albo null, gdy go nie ma)
        this.avatars = new Map();

        this.avatarsDir = path.join(this.logsDir, '_avatars');
        fs.ensureDirSync(this.logsDir);
        if (config.SAVE_PROFILE_PICS) fs.ensureDirSync(this.avatarsDir);
    }

    // ─────────────────────────────────────────────────────────────
    //  Kolejka - jeden czat obsługiwany po kolei
    // ─────────────────────────────────────────────────────────────

    /**
     * Dokleja zadanie do łańcucha promisów danego czatu. Dwie wiadomości
     * z tego samego czatu nigdy nie wykonują się równolegle, więc nie ma
     * wyścigu przy tworzeniu stanu ani przy zapisie plików.
     */
    _enqueue(chatId, task) {
        const previous = this.queues.get(chatId) || Promise.resolve();
        const next = previous.then(task, task);
        this.queues.set(chatId, next.catch(() => {}));
        return next;
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

            return await this._enqueue(chatId, () => this._processMessage(message, chatId, chatName));
        } catch (err) {
            this._reportError(err, message);
        }
    }

    async _processMessage(message, chatId, chatName) {
        try {
            if (!this.chatStates.has(chatId)) {
                await this._initChatState(chatId, chatName);
            }

            const state = this.chatStates.get(chatId);

            // Nazwa nadawcy i jego zdjęcie profilowe
            let senderName = 'Nieznany';
            let avatar     = null;
            if (message.fromMe) {
                senderName = 'Ja';
            } else {
                try {
                    const contact = await message.getContact();
                    senderName = this._contactName(contact) || message.author || message.from || 'Nieznany';
                    avatar = await this._profilePic(contact);
                } catch {
                    senderName = message.author || message.from || 'Nieznany';
                }
            }

            // Pobierz media (jeśli typ jest na liście i rozmiar w normie).
            // Gdy pliku nie pobieramy, zostaje notatka z typem, nazwą i rozmiarem.
            let mediaPath    = null;
            let mediaName    = null;
            let mediaSkipped = null;
            if (message.hasMedia) {
                if (config.MEDIA_TYPES.includes(message.type)) {
                    const result = await this._downloadMedia(message, state);
                    mediaPath    = result.path;
                    mediaName    = result.name;
                    mediaSkipped = result.skipped;
                } else {
                    mediaSkipped = {
                        reason:   'typ wyłączony w konfiguracji',
                        type:     message.type,
                        filename: message._data?.filename || null,
                        bytes:    message._data?.size || null,
                    };
                }
            }

            // Cytowana wiadomość
            let quotedInfo = null;
            if (message.hasQuotedMsg) {
                try {
                    const quoted = await message.getQuotedMessage();
                    if (quoted) {
                        let quotedSender = 'Nieznany';
                        if (quoted.fromMe) {
                            quotedSender = 'Ja';
                        } else {
                            try {
                                quotedSender = this._contactName(await quoted.getContact())
                                    || quoted.author || quoted.from || 'Nieznany';
                            } catch {
                                quotedSender = quoted.author || quoted.from || 'Nieznany';
                            }
                        }
                        quotedInfo = {
                            sender: quotedSender,
                            body:   quoted.body || this._typeLabel(quoted.type),
                        };
                    }
                } catch { /* ignore */ }
            }

            const msgData = {
                id:          message.id._serialized,
                timestamp:   message.timestamp,
                from:        senderName,
                fromMe:      message.fromMe,
                avatar,
                // Uwaga: przy zdjęciach i filmach whatsapp-web.js wkłada podpis
                // właśnie do body, osobnego pola z podpisem nie ma.
                body:        message.body || '',
                type:        message.type,
                mediaPath,
                mediaName,
                mediaSkipped,
                isDeleted:   false,
                isForwarded: message.isForwarded || false,
                quotedMsg:   quotedInfo,
                location:    this._locationData(message),
                contacts:    this._vcardData(message),
                poll:        this._pollData(message),
            };

            state.pendingMessages.push(msgData);
            state.totalMessages++;

            // Jeśli partia pełna - zrzuć do HTML
            if (state.pendingMessages.length >= config.MESSAGES_PER_FILE) {
                await this._flushBatch(chatId);
            } else {
                this._scheduleStateSave(chatId);
            }

            const preview = (message.body || `[${message.type}]`).substring(0, 60);
            console.log(`[${chatName}] ${message.fromMe ? '>' : '<'} ${senderName}: ${preview}`);

        } catch (err) {
            this._reportError(err, message);
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
                return this._enqueue(chatId, async () => {
                    found.isDeleted = true;
                    await this._saveStateJson(chatId);
                    console.log(`[Usunięta - zachowana] ${found.from}: ${found.body.substring(0, 60)}`);
                });
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
        for (const chatId of [...this.chatStates.keys()]) {
            await this._enqueue(chatId, () => this._flushBatch(chatId));
        }
        console.log('Wszystkie oczekujące wiadomości zostały zapisane.');
    }

    // ─────────────────────────────────────────────────────────────
    //  Kasowanie starych wiadomości oczekujących w pamięci
    // ─────────────────────────────────────────────────────────────

    /**
     * Wyrzuca z bieżącej partii wiadomości starsze niż podana liczba dni.
     * Bez tego w cichym czacie wiadomość mogłaby czekać w _state.json latami.
     */
    async pruneOldPending(days) {
        if (!days || days <= 0) return 0;
        const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
        let removed = 0;

        for (const chatId of [...this.chatStates.keys()]) {
            await this._enqueue(chatId, async () => {
                const state = this.chatStates.get(chatId);
                if (!state) return;
                const before = state.pendingMessages.length;
                state.pendingMessages = state.pendingMessages.filter(m => m.timestamp >= cutoff);
                const diff = before - state.pendingMessages.length;
                if (diff > 0) {
                    removed += diff;
                    await this._saveStateJson(chatId);
                }
            });
        }
        if (removed > 0) {
            console.log(`[Kasowanie] usunięto ${removed} oczekujących wiadomości starszych niż ${days} dni`);
        }
        return removed;
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
            saveTimer:       null,
            lastSaveAt:      0,
        });
    }

    async _flushBatch(chatId) {
        const state = this.chatStates.get(chatId);
        if (!state || state.pendingMessages.length === 0) return;

        const filename = `messages_${String(state.batchNum).padStart(4, '0')}.html`;
        const filepath = path.join(state.chatDir, filename);

        const html = generateHtml({
            chatName:     state.name,
            batchNum:     state.batchNum,
            messages:     state.pendingMessages,
            // Ta partia jest w tej chwili najnowsza, więc odnośnik "dalej"
            // zostaje wyszarzony. Odblokujemy go przy zapisie kolejnej partii.
            totalBatches: state.batchNum,
        });

        await fs.writeFile(filepath, html, 'utf8');
        console.log(`Zapisano: ${filepath} (${state.pendingMessages.length} wiad.)`);

        await this._unlockNextLink(state, state.batchNum - 1);

        state.batchNum++;
        state.pendingMessages = [];

        await this._saveStateJson(chatId);
    }

    /**
     * W poprzednim pliku odnośnik "dalej" był wyszarzony, bo kolejnej części
     * jeszcze nie było. Teraz już jest, więc podmieniamy go na działający.
     */
    async _unlockNextLink(state, batchNum) {
        if (batchNum < 1) return;
        const file = path.join(state.chatDir, `messages_${String(batchNum).padStart(4, '0')}.html`);
        try {
            if (!await fs.pathExists(file)) return;
            const html = await fs.readFile(file, 'utf8');
            if (!html.includes(NEXT_LINK_MARKER.open)) return;

            const pattern = new RegExp(
                NEXT_LINK_MARKER.open + '[\\s\\S]*?' + NEXT_LINK_MARKER.close,
                'g',
            );
            const replacement = NEXT_LINK_MARKER.open + buildNextLink(batchNum + 1) + NEXT_LINK_MARKER.close;
            await fs.writeFile(file, html.replace(pattern, replacement), 'utf8');
        } catch (err) {
            console.warn('Nie udało się odblokować odnośnika w poprzedniej części:', err.message);
        }
    }

    /**
     * Zapis _state.json nie częściej niż co STATE_SAVE_INTERVAL_MS.
     * Pierwszy zapis idzie od razu, kolejne są doklejane do timera.
     */
    _scheduleStateSave(chatId) {
        const state = this.chatStates.get(chatId);
        if (!state) return;

        const interval = config.STATE_SAVE_INTERVAL_MS || 0;
        const sinceLast = Date.now() - state.lastSaveAt;

        if (interval <= 0 || sinceLast >= interval) {
            return this._saveStateJson(chatId);
        }
        if (state.saveTimer) return;

        state.saveTimer = setTimeout(() => {
            state.saveTimer = null;
            this._enqueue(chatId, () => this._saveStateJson(chatId));
        }, interval - sinceLast);
        // Oczekujący zapis nie może trzymać procesu przy życiu
        if (typeof state.saveTimer.unref === 'function') state.saveTimer.unref();
    }

    async _saveStateJson(chatId) {
        const state = this.chatStates.get(chatId);
        if (!state) return;

        if (state.saveTimer) {
            clearTimeout(state.saveTimer);
            state.saveTimer = null;
        }
        state.lastSaveAt = Date.now();

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
        const meta = {
            type:     message.type,
            filename: message._data?.filename || null,
            bytes:    message._data?.size || null,
        };

        try {
            const media = await message.downloadMedia();
            if (!media || !media.data) {
                return { path: null, name: null, skipped: { ...meta, reason: 'nie udało się pobrać pliku' } };
            }

            // Sprawdź rozmiar (base64 → bajty ≈ długość × 0,75)
            const sizeBytes = Math.round((media.data.length * 3) / 4);
            const sizeMB    = sizeBytes / (1024 * 1024);
            meta.bytes    = sizeBytes;
            meta.filename = meta.filename || media.filename || null;

            if (sizeMB > config.MAX_MEDIA_SIZE_MB) {
                console.log(`Pominięto plik - za duży: ${sizeMB.toFixed(1)} MB (limit: ${config.MAX_MEDIA_SIZE_MB} MB)`);
                return {
                    path: null,
                    name: null,
                    skipped: { ...meta, reason: `plik ponad limit ${config.MAX_MEDIA_SIZE_MB} MB` },
                };
            }

            // Wyznacz rozszerzenie z MIME
            const mime = media.mimetype || 'application/octet-stream';
            const ext  = mime.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg') || 'bin';

            const filename  = `${Date.now()}_${message.id.id.substring(0, 10)}.${ext}`;
            const absPath   = path.join(state.mediaDir, filename);

            await fs.writeFile(absPath, Buffer.from(media.data, 'base64'));

            // Zwróć ścieżkę względną (od folderu czatu) - do użycia w HTML
            return { path: path.relative(state.chatDir, absPath), name: meta.filename, skipped: null };
        } catch (err) {
            console.error('Błąd pobierania mediów:', err.message);
            return { path: null, name: null, skipped: { ...meta, reason: `błąd pobierania: ${err.message}` } };
        }
    }

    // ── Kontakty ──────────────────────────────────────────────────

    _contactName(contact) {
        if (!contact) return null;
        const id = contact.id?._serialized;
        if (id && this.contactNames.has(id)) return this.contactNames.get(id);

        const name = contact.name || contact.pushname || contact.shortName || contact.number || null;
        if (id) this.contactNames.set(id, name);
        return name;
    }

    /**
     * Pobiera zdjęcie profilowe do logs/_avatars i zwraca ścieżkę względną
     * z punktu widzenia folderu czatu. null, gdy kontakt nie ma zdjęcia.
     */
    async _profilePic(contact) {
        if (!config.SAVE_PROFILE_PICS || !contact) return null;
        const id = contact.id?._serialized;
        if (!id) return null;
        if (this.avatars.has(id)) return this.avatars.get(id);

        const safeId  = id.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const file    = path.join(this.avatarsDir, `${safeId}.jpg`);
        const relPath = `../_avatars/${safeId}.jpg`;

        try {
            // Świeże zdjęcie zostawiamy w spokoju, stare odświeżamy
            if (await fs.pathExists(file)) {
                const info = await fs.stat(file);
                const ageDays = (Date.now() - info.mtimeMs) / (24 * 60 * 60 * 1000);
                if (ageDays < AVATAR_MAX_AGE_DAYS) {
                    this.avatars.set(id, relPath);
                    return relPath;
                }
            }

            const url = await contact.getProfilePicUrl();
            if (!url) {
                this.avatars.set(id, null);
                return null;
            }

            const buffer = await this._fetchBuffer(url);
            await fs.ensureDir(this.avatarsDir);
            await fs.writeFile(file, buffer);
            this.avatars.set(id, relPath);
            return relPath;
        } catch {
            // Brak zdjęcia albo błąd sieci - zapamiętujemy, żeby nie próbować co wiadomość
            this.avatars.set(id, null);
            return null;
        }
    }

    _fetchBuffer(url) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('http://') ? http : https;
            const req = client.get(url, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', reject);
            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error('timeout'));
            });
        });
    }

    // ── Wiadomości bez treści tekstowej ───────────────────────────

    _locationData(message) {
        if (message.type !== 'location' || !message.location) return null;
        const loc = message.location;
        return {
            latitude:  loc.latitude,
            longitude: loc.longitude,
            name:      loc.name    || null,
            address:   loc.address || null,
        };
    }

    _vcardData(message) {
        const cards = message.vCards;
        if (!Array.isArray(cards) || cards.length === 0) return null;

        return cards.map((raw) => {
            const text = String(raw || '');
            const name = text.match(/^FN[^:]*:(.+)$/mi)?.[1]?.trim() || null;
            const numbers = [...text.matchAll(/^TEL[^:]*:(.+)$/gmi)]
                .map(m => m[1].trim())
                .filter(Boolean);
            const org = text.match(/^ORG[^:]*:(.+)$/mi)?.[1]?.trim() || null;
            return { name, numbers, org };
        });
    }

    _pollData(message) {
        if (message.type !== 'poll_creation') return null;
        const options = Array.isArray(message.pollOptions)
            ? message.pollOptions.map(o => (typeof o === 'string' ? o : o?.name)).filter(Boolean)
            : [];
        return {
            question: message.pollName || null,
            options,
            multiple: Boolean(message.allowMultipleAnswers),
        };
    }

    _typeLabel(type) {
        const labels = {
            image:    '[zdjęcie]',
            video:    '[film]',
            audio:    '[nagranie]',
            ptt:      '[wiadomość głosowa]',
            document: '[dokument]',
            sticker:  '[naklejka]',
            location: '[lokalizacja]',
            vcard:    '[kontakt]',
            multi_vcard: '[kontakty]',
            poll_creation: '[ankieta]',
            revoked:  '[wiadomość skasowana]',
        };
        return labels[type] || '[media]';
    }

    // ── Błędy ─────────────────────────────────────────────────────

    _reportError(err, message) {
        console.error('Błąd saveMessage:', err.message);
        if (err.stack) {
            const stackLine = err.stack.split('\n')[1]?.trim();
            if (stackLine) console.error('  w', stackLine);
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

    async _logDeletedId(msgId) {
        const logFile = path.join(this.logsDir, '_deleted_ids.log');
        try {
            await fs.appendFile(logFile, `${new Date().toISOString()} ${msgId}\n`, 'utf8');
        } catch { /* ignore */ }
    }
}

module.exports = { Storage };
