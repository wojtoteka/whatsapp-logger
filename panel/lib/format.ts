// Formatowanie dat, rozmiarów i etykiet - wszystko po polsku.

const PL = 'pl-PL';

export function formatTime(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString(PL, { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString(PL, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
}

export function formatDateTime(ts: number): string {
    return new Date(ts * 1000).toLocaleString(PL, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function isoDate(ts: number): string {
    return new Date(ts * 1000).toISOString();
}

/** Sama godzina z zapisu ISO. Null, gdy zapisu nie da się odczytać. */
export function isoTime(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const value = Date.parse(iso);
    return Number.isFinite(value) ? formatTime(value / 1000) : null;
}

/** Data z godziną z zapisu ISO. Null, gdy zapisu nie da się odczytać. */
export function isoDateTime(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const value = Date.parse(iso);
    return Number.isFinite(value) ? formatDateTime(value / 1000) : null;
}

/** "wczoraj", "3 dni temu" - to, co czyta się na liście czatów. */
export function relativeDay(ts: number | null): string {
    if (!ts) return 'brak wiadomości';

    const then = new Date(ts * 1000);
    const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);

    if (days <= 0) return formatTime(ts);
    if (days === 1) return 'wczoraj';
    if (days < 7) return `${days} dni temu`;
    return then.toLocaleDateString(PL, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function formatBytes(bytes: number | null | undefined): string | null {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Odmiana rzeczownika po liczbie: 1 wiadomość, 2 wiadomości, 5 wiadomości. */
export function plural(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10;
    const mod100 = count % 100;

    if (count === 1) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

export function messageCount(count: number): string {
    return `${count} ${plural(count, 'wiadomość', 'wiadomości', 'wiadomości')}`;
}

const TYPE_NAMES: Record<string, string> = {
    image: 'zdjęcie',
    video: 'film',
    audio: 'nagranie',
    ptt: 'wiadomość głosowa',
    document: 'dokument',
    sticker: 'naklejka',
    location: 'lokalizacja',
    vcard: 'kontakt',
    multi_vcard: 'kontakty',
    poll_creation: 'ankieta',
    revoked: 'wiadomość skasowana',
};

export function typeName(type: string): string {
    return TYPE_NAMES[type] ?? type;
}

/** Stały kolor imienia nadawcy, liczony z jego nazwy. */
export function senderTone(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 100000;
    return `n${(hash % 6) + 1}`;
}

export function initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
}

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const VIDEO_EXT = ['mp4', '3gp', 'mov', 'avi', 'webm'];
const AUDIO_EXT = ['ogg', 'mp3', 'opus', 'm4a', 'aac', 'mpeg', 'wav'];

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export function mediaKind(mediaPath: string, type: string): MediaKind {
    if (type === 'sticker') return 'image';
    const ext = (mediaPath.split('.').pop() ?? '').toLowerCase();

    if (IMAGE_EXT.includes(ext)) return 'image';
    if (VIDEO_EXT.includes(ext)) return 'video';
    if (AUDIO_EXT.includes(ext)) return 'audio';
    return 'file';
}
