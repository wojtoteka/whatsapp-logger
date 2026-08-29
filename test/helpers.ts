// Wspólne atrapy do testów: konfiguracja na folderze tymczasowym,
// udawany klient WhatsAppa i udawana wiadomość.
//
// Plik nie zawiera żadnych testów - to sam warsztat.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config';
import { MEDIA_TYPES_ALL } from '../src/config';
import type { WaClient, WaMessage } from '../src/types';

/** Konfiguracja wskazująca na świeży folder tymczasowy. */
export function testConfig(logsDir: string, overrides: Partial<Config> = {}): Config {
    return {
        lockedChatPassword: '',
        discordWebhookUrl: '',
        discordPingUserId: '',

        logsDir,
        messagesPerFile: 3,
        mediaTypes: new Set(MEDIA_TYPES_ALL),
        maxMediaSizeMb: 100,

        saveProfilePics: false,
        avatarRefreshDays: 30,

        saveStatuses: true,
        sweepCheckHours: 6,

        retentionEnabled: true,
        retentionDays: 180,
        retentionCheckHours: 12,

        // Testy nie dotykają bazy - sprawdzają samo archiwum na dysku.
        dbEnabled: false,
        dbHost: '127.0.0.1',
        dbPort: 3306,
        dbUser: 'test',
        dbPassword: '',
        dbName: 'test',

        panelEnabled: false,
        panelHost: '127.0.0.1',
        panelPort: 3000,

        chromePath: null,
        headless: true,
        logLevel: 'error',
        // Zapis stanu bez opóźnienia - testy nie mają czasu czekać na timer.
        stateSaveIntervalMs: 0,
        ...overrides,
    };
}

/** Zakłada folder tymczasowy, oddaje go funkcji i sprząta po niej. */
export async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-logger-test-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

export interface FakeContact {
    id?: { _serialized: string };
    number?: string;
    name?: string;
    pushname?: string;
    shortName?: string;
    isMyContact?: boolean;
}

export interface FakeClientOptions {
    /** Odpowiedzi getContactById, po identyfikatorze. */
    contacts?: Record<string, FakeContact>;
    /** Mapowanie @lid → identyfikator z numerem telefonu. */
    lidToPhone?: Record<string, string>;
    /** Relacje zwracane przez getBroadcasts. */
    broadcasts?: Array<{ msgs: WaMessage[] }>;
    /** Adresy zdjęć profilowych, po identyfikatorze. */
    profilePics?: Record<string, string>;
}

/** Minimalny klient WhatsAppa - tyle, ile potrzebują testowane moduły. */
export function fakeClient(options: FakeClientOptions = {}): WaClient {
    const client = {
        async getContactById(id: string) {
            const contact = options.contacts?.[id];
            if (!contact) throw new Error(`brak kontaktu ${id}`);
            return contact;
        },
        async getContactLidAndPhone(ids: string[]) {
            return ids.map((id) => ({
                lid: id,
                pn: options.lidToPhone?.[id] ?? '',
            }));
        },
        async getBroadcasts() {
            return options.broadcasts ?? [];
        },
        async getProfilePicUrl(id: string) {
            return options.profilePics?.[id] ?? '';
        },
        async sendPresenceUnavailable() {
            /* nic */
        },
    };
    return client as unknown as WaClient;
}

export interface FakeMessageOptions {
    id?: string;
    from?: string;
    to?: string;
    author?: string;
    fromMe?: boolean;
    body?: string;
    type?: string;
    timestamp?: number;
    notifyName?: string;
    isStatus?: boolean;
    hasMedia?: boolean;
    contact?: FakeContact | null;
    /** Nazwa czatu zwracana przez getChat. Brak = getChat rzuca błędem. */
    chatName?: string | null;
    /**
     * true odtwarza kształt relacji z getBroadcasts(): identyfikator bez
     * pola _serialized, bo whatsapp-web.js buduje je z surowego serialize().
     */
    rawStatusId?: boolean;
}

/** Udawana wiadomość w kształcie, jaki podaje whatsapp-web.js. */
export function fakeMessage(options: FakeMessageOptions = {}): WaMessage {
    const from = options.from ?? '111222333444555@lid';

    const rawId = options.id ?? 'msg-1';
    const id = options.rawStatusId
        ? { id: rawId, remote: 'status@broadcast', participant: from, fromMe: false }
        : { _serialized: rawId, id: rawId, remote: from };

    const message = {
        id,
        timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
        from,
        to: options.to ?? 'me@c.us',
        author: options.author,
        fromMe: options.fromMe ?? false,
        body: options.body ?? '',
        type: options.type ?? 'chat',
        hasMedia: options.hasMedia ?? false,
        hasQuotedMsg: false,
        isForwarded: false,
        isStatus: options.isStatus ?? false,
        vCards: [],
        location: undefined,
        _data: options.notifyName ? { notifyName: options.notifyName } : {},

        async getChat() {
            if (options.chatName === undefined || options.chatName === null) {
                throw new Error('getChat niedostępne dla tego czatu');
            }
            return { name: options.chatName, id: { _serialized: from } };
        },
        async getContact() {
            if (!options.contact) throw new Error('brak kontaktu');
            return options.contact;
        },
        async downloadMedia() {
            return null;
        },
    };
    return message as unknown as WaMessage;
}
