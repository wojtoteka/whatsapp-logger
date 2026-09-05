// Cała konfiguracja programu w jednym miejscu: plik .env w katalogu projektu.
//
// Kolejność źródeł: zmienna środowiskowa systemu ma pierwszeństwo przed .env,
// a brakująca wartość spada na sensowną wartość domyślną. Nic nie jest
// rozsypane po plikach .js - jeden plik .env i tyle.

import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Typy wiadomości, których pliki program potrafi zapisać na dysk. */
export const MEDIA_TYPES_ALL = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'] as const;
export type MediaType = (typeof MEDIA_TYPES_ALL)[number];

export interface Config {
    /**
     * Ile kodów QR pokazać, zanim logger sam się wyłączy. Niezeskanowany kod
     * odświeża się co kilkadziesiąt sekund, więc bez limitu czekanie przez noc
     * zostawia tysiące kodów w terminalu. 0 = bez limitu.
     */
    qrMaxCodes: number;

    /** Kod do zablokowanych czatów. Pusty = obsługa wyłączona. */
    lockedChatPassword: string;
    /** Webhook Discorda. Pusty = powiadomienia wyłączone. */
    discordWebhookUrl: string;
    /** Kogo pingować przy utracie autoryzacji. Pusty = bez pingu. */
    discordPingUserId: string;

    /** Folder archiwum, zawsze ścieżka bezwzględna. */
    logsDir: string;
    messagesPerFile: number;
    /** Ile ostatnich wiadomości z każdego czatu przejrzeć po uruchomieniu. */
    backfillMessagesPerChat: number;
    /** Co ile minut lekko ponawiać synchronizację znanych czatów. 0 = wyłączone. */
    syncIntervalMinutes: number;
    mediaTypes: ReadonlySet<string>;
    maxMediaSizeMb: number;

    saveProfilePics: boolean;
    avatarRefreshDays: number;

    saveStatuses: boolean;
    sweepCheckHours: number;

    /**
     * Czy archiwizować kanały WhatsAppa. Domyślnie nie: kanał to nadajnik,
     * na którym subskrybent i tak nic nie pisze, a filmy z niego potrafią
     * zająć więcej miejsca niż wszystkie prawdziwe rozmowy razem.
     */
    saveChannels: boolean;

    /** Archiwizowanie rozmowy z ChatGPT (+1 800 242 8478). Nie wyłącza ?tau. */
    saveAiChat: boolean;

    retentionEnabled: boolean;
    retentionDays: number;
    retentionCheckHours: number;

    /** Zapis do MariaDB. Wyłączony = działa samo archiwum na dysku. */
    dbEnabled: boolean;
    dbHost: string;
    dbPort: number;
    dbUser: string;
    dbPassword: string;
    dbName: string;

    /** Uruchamianie panelu razem z loggerem. */
    panelEnabled: boolean;
    panelHost: string;
    panelPort: number;
    /** Wpuszczaj do panelu wyłącznie klientów z sieci lokalnej. */
    panelLanOnly: boolean;
    /** Dodatkowe adresy lub zakresy CIDR poza sieciami prywatnymi, np. VPN. */
    panelAllowedIps: string[];

    /** Prywatny asystent ?tau korzystający z numeru ChatGPT w WhatsAppie. */
    tauEnabled: boolean;
    /** Numer providera bez plusa, spacji ani myślników. */
    tauProviderNumber: string;
    tauTimeoutSeconds: number;
    /** Nigdy więcej niż 200 tekstowych wiadomości. */
    tauMaxMessages: number;
    /** Dodatkowy limit rozmiaru pojedynczego requestu WhatsApp. */
    tauMaxContextChars: number;

    chromePath: string | null;
    headless: boolean;
    logLevel: LogLevel;
    stateSaveIntervalMs: number;
}

export interface LoadResult {
    config: Config;
    /** Uwagi do wypisania przy starcie: literówki, wartości poza zakresem. */
    warnings: string[];
    /** Czy .env w ogóle istnieje - bez niego lecimy na samych domyślnych. */
    envFileFound: boolean;
}

/**
 * Wczytuje .env do process.env. Node robi to sam od 20.6, więc nie ma tu
 * żadnej zewnętrznej biblioteki. Zmienna ustawiona wcześniej w systemie
 * wygrywa z plikiem - przywracamy ją po wczytaniu.
 */
export function loadEnvFile(rootDir: string): boolean {
    const file = path.join(rootDir, '.env');
    if (!fs.existsSync(file)) return false;

    const before = new Map<string, string | undefined>(
        Object.keys(process.env).map((key) => [key, process.env[key]]),
    );
    process.loadEnvFile(file);
    for (const [key, value] of before) {
        if (value !== undefined) process.env[key] = value;
    }
    return true;
}

// -- Odczyt pojedynczych wartości -----------------------------------------

type Env = Record<string, string | undefined>;

function raw(env: Env, key: string): string | null {
    const value = env[key];
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readText(env: Env, key: string, fallback = ''): string {
    return raw(env, key) ?? fallback;
}

/** Lista po przecinku, bez pustych wpisów - np. adresy dopuszczone do panelu. */
function readList(env: Env, key: string): string[] {
    return readText(env, key)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function readBool(env: Env, key: string, fallback: boolean, warnings: string[]): boolean {
    const value = raw(env, key);
    if (value === null) return fallback;

    const lowered = value.toLowerCase();
    if (['true', '1', 'tak', 'yes', 'on'].includes(lowered)) return true;
    if (['false', '0', 'nie', 'no', 'off'].includes(lowered)) return false;

    warnings.push(`${key}: "${value}" to nie jest true ani false - biorę ${fallback}`);
    return fallback;
}

interface NumberRange {
    min?: number;
    max?: number;
}

function readNumber(
    env: Env,
    key: string,
    fallback: number,
    warnings: string[],
    range: NumberRange = {},
): number {
    const value = raw(env, key);
    if (value === null) return fallback;

    const parsed = Number(value.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
        warnings.push(`${key}: "${value}" to nie jest liczba - biorę ${fallback}`);
        return fallback;
    }
    if (range.min !== undefined && parsed < range.min) {
        warnings.push(`${key}: ${parsed} jest poniżej dopuszczalnego ${range.min} - biorę ${range.min}`);
        return range.min;
    }
    if (range.max !== undefined && parsed > range.max) {
        warnings.push(`${key}: ${parsed} przekracza dopuszczalne ${range.max} - biorę ${range.max}`);
        return range.max;
    }
    return parsed;
}

function readMediaTypes(env: Env, warnings: string[]): ReadonlySet<string> {
    const value = raw(env, 'MEDIA_TYPES');
    if (value === null) return new Set(MEDIA_TYPES_ALL);

    // "brak" i "none" to jawne wyłączenie pobierania czegokolwiek.
    if (['brak', 'none', '-'].includes(value.toLowerCase())) return new Set();

    const wanted = value
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0);

    const known = new Set<string>();
    for (const type of wanted) {
        if ((MEDIA_TYPES_ALL as readonly string[]).includes(type)) known.add(type);
        else warnings.push(`MEDIA_TYPES: "${type}" nie jest znanym typem - pomijam`);
    }
    if (known.size === 0) {
        warnings.push('MEDIA_TYPES: nie zostało nic sensownego - żadne media nie będą pobierane');
    }
    return known;
}

function readLogLevel(env: Env, warnings: string[]): LogLevel {
    const value = raw(env, 'LOG_LEVEL')?.toLowerCase() ?? 'info';
    if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;

    warnings.push(`LOG_LEVEL: "${value}" nie jest znanym poziomem - biorę info`);
    return 'info';
}

/** Klucze, które program rozumie. Reszta w .env to najpewniej literówka. */
const KNOWN_KEYS = new Set([
    'QR_MAX_CODES',
    'LOCKED_CHAT_PASSWORD',
    'DISCORD_WEBHOOK_URL',
    'DISCORD_PING_USER_ID',
    'LOGS_DIR',
    'MESSAGES_PER_FILE',
    'BACKFILL_MESSAGES_PER_CHAT',
    'SYNC_INTERVAL_MINUTES',
    'MEDIA_TYPES',
    'MAX_MEDIA_SIZE_MB',
    'SAVE_PROFILE_PICS',
    'AVATAR_REFRESH_DAYS',
    'SAVE_STATUSES',
    'SWEEP_CHECK_HOURS',
    'SAVE_CHANNELS',
    'SAVE_AI_CHAT',
    'RETENTION_ENABLED',
    'RETENTION_DAYS',
    'RETENTION_CHECK_HOURS',
    'DB_ENABLED',
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'PANEL_ENABLED',
    'PANEL_HOST',
    'PANEL_PORT',
    'PANEL_LAN_ONLY',
    'PANEL_ALLOWED_IPS',
    'TAU_ENABLED',
    'TAU_PROVIDER_NUMBER',
    'TAU_TIMEOUT_SECONDS',
    'TAU_MAX_MESSAGES',
    'TAU_MAX_CONTEXT_CHARS',
    'CHROME_PATH',
    'HEADLESS',
    'LOG_LEVEL',
    'STATE_SAVE_INTERVAL_MS',
]);

/**
 * Wyłapuje literówki w .env. Patrzymy wyłącznie na klucze z pliku, bo
 * process.env jest pełen zmiennych systemu, które nas nie dotyczą.
 */
function warnAboutUnknownKeys(rootDir: string, warnings: string[]): void {
    let text: string;
    try {
        text = fs.readFileSync(path.join(rootDir, '.env'), 'utf8');
    } catch {
        return;
    }

    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

        const key = trimmed.split('=')[0]?.trim();
        if (key && !KNOWN_KEYS.has(key)) {
            warnings.push(`.env zawiera nieznane ustawienie "${key}" - literówka?`);
        }
    }
}

/**
 * Buduje komplet ustawień. rootDir to katalog programu; ścieżki względne
 * z .env liczą się właśnie od niego, a nie od katalogu, z którego akurat
 * uruchomiono polecenie.
 */
export function loadConfig(rootDir: string, env: Env = process.env): LoadResult {
    const warnings: string[] = [];
    const envFileFound = loadEnvFile(rootDir);
    if (envFileFound) warnAboutUnknownKeys(rootDir, warnings);

    const logsDirRaw = readText(env, 'LOGS_DIR', './logs');

    const config: Config = {
        qrMaxCodes: readNumber(env, 'QR_MAX_CODES', 3, warnings, { min: 0, max: 1000 }),

        lockedChatPassword: readText(env, 'LOCKED_CHAT_PASSWORD'),
        discordWebhookUrl: readText(env, 'DISCORD_WEBHOOK_URL'),
        discordPingUserId: readText(env, 'DISCORD_PING_USER_ID'),

        logsDir: path.resolve(rootDir, logsDirRaw),
        messagesPerFile: readNumber(env, 'MESSAGES_PER_FILE', 70, warnings, { min: 1, max: 10000 }),
        backfillMessagesPerChat: readNumber(env, 'BACKFILL_MESSAGES_PER_CHAT', 250, warnings, {
            min: 0,
            max: 10000,
        }),
        syncIntervalMinutes: readNumber(env, 'SYNC_INTERVAL_MINUTES', 15, warnings, {
            min: 0,
            max: 1440,
        }),
        mediaTypes: readMediaTypes(env, warnings),
        maxMediaSizeMb: readNumber(env, 'MAX_MEDIA_SIZE_MB', 100, warnings, { min: 0, max: 2048 }),

        saveProfilePics: readBool(env, 'SAVE_PROFILE_PICS', true, warnings),
        avatarRefreshDays: readNumber(env, 'AVATAR_REFRESH_DAYS', 30, warnings, { min: 1, max: 3650 }),

        saveStatuses: readBool(env, 'SAVE_STATUSES', true, warnings),
        sweepCheckHours: readNumber(env, 'SWEEP_CHECK_HOURS', 6, warnings, { min: 0.25, max: 720 }),

        saveChannels: readBool(env, 'SAVE_CHANNELS', false, warnings),
        saveAiChat: readBool(env, 'SAVE_AI_CHAT', false, warnings),

        retentionEnabled: readBool(env, 'RETENTION_ENABLED', true, warnings),
        retentionDays: readNumber(env, 'RETENTION_DAYS', 180, warnings, { min: 0, max: 36500 }),
        retentionCheckHours: readNumber(env, 'RETENTION_CHECK_HOURS', 12, warnings, { min: 0.25, max: 720 }),

        dbEnabled: readBool(env, 'DB_ENABLED', false, warnings),
        dbHost: readText(env, 'DB_HOST', '127.0.0.1'),
        dbPort: readNumber(env, 'DB_PORT', 3306, warnings, { min: 1, max: 65535 }),
        dbUser: readText(env, 'DB_USER', 'root'),
        dbPassword: readText(env, 'DB_PASSWORD'),
        dbName: readText(env, 'DB_NAME', 'whatsapp_logger'),

        panelEnabled: readBool(env, 'PANEL_ENABLED', true, warnings),
        panelHost: readText(env, 'PANEL_HOST', '127.0.0.1'),
        panelPort: readNumber(env, 'PANEL_PORT', 3000, warnings, { min: 1, max: 65535 }),
        panelLanOnly: readBool(env, 'PANEL_LAN_ONLY', true, warnings),
        panelAllowedIps: readList(env, 'PANEL_ALLOWED_IPS'),

        tauEnabled: readBool(env, 'TAU_ENABLED', false, warnings),
        tauProviderNumber: readText(env, 'TAU_PROVIDER_NUMBER', '18002428478').replace(/\D/g, ''),
        tauTimeoutSeconds: readNumber(env, 'TAU_TIMEOUT_SECONDS', 120, warnings, {
            min: 10,
            max: 600,
        }),
        tauMaxMessages: readNumber(env, 'TAU_MAX_MESSAGES', 200, warnings, {
            min: 1,
            max: 200,
        }),
        tauMaxContextChars: readNumber(env, 'TAU_MAX_CONTEXT_CHARS', 40000, warnings, {
            min: 2000,
            max: 55000,
        }),

        chromePath: raw(env, 'CHROME_PATH'),
        headless: readBool(env, 'HEADLESS', true, warnings),
        logLevel: readLogLevel(env, warnings),
        stateSaveIntervalMs: readNumber(env, 'STATE_SAVE_INTERVAL_MS', 5000, warnings, { min: 0, max: 600000 }),
    };

    if (config.dbEnabled && !config.dbName) {
        warnings.push('DB_ENABLED jest włączone, ale DB_NAME jest puste - zapis do bazy nie ruszy');
    }
    if (config.discordPingUserId && !config.discordWebhookUrl) {
        warnings.push('DISCORD_PING_USER_ID jest ustawione, ale bez DISCORD_WEBHOOK_URL nic nie wyśle');
    }
    if (config.tauEnabled && config.tauProviderNumber.length < 8) {
        warnings.push('TAU_PROVIDER_NUMBER nie wygląda na pełny numer międzynarodowy - ?tau nie zadziała');
    }
    // Adres podaje się samą nazwą albo samym IP. "http://" z przodu czy
    // ":3000" na końcu wygląda naturalnie, ale Next tego nie przyjmie
    // i panel nie wstanie - a komunikat będzie o czymś zupełnie innym.
    if (config.panelHost && (config.panelHost.includes('/') || /:[0-9]+$/.test(config.panelHost))) {
        warnings.push(
            `PANEL_HOST=${config.panelHost} - podaj sam adres, bez http:// i bez portu (port ustawia PANEL_PORT)`,
        );
    }
    // Adres nasłuchu niczego nie chroni, gdy router przekazuje ruch z
    // internetu na ten sam adres LAN (DMZ, przekierowanie portu).
    if (config.panelEnabled && !config.panelLanOnly && config.panelHost !== '127.0.0.1') {
        warnings.push(
            `PANEL_LAN_ONLY=false przy PANEL_HOST=${config.panelHost} - panel przyjmie połączenie ` +
                'z dowolnego adresu, także z internetu, jeżeli router go tu przekazuje',
        );
    }
    if (
        config.discordWebhookUrl &&
        !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(config.discordWebhookUrl)
    ) {
        warnings.push('DISCORD_WEBHOOK_URL nie wygląda na adres webhooka Discorda');
    }

    return { config, warnings, envFileFound };
}
