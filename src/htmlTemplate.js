// Generator plików HTML z wiadomościami WhatsApp
//
// Wygląd: ciemna morska tonacja, bąbelki jak w komunikatorze. Twoje po prawej
// w zieleni morskiej, cudze po lewej na granatowym panelu. Pasek z nazwą czatu
// trzyma się góry przy przewijaniu, a w grupach każdy nadawca ma stały kolor imienia.

const config = require('./config');

// Znaczniki wokół odnośnika "dalej". W chwili zapisu partia jest najnowsza,
// więc odnośnik jest wyszarzony. Gdy powstanie kolejna część, storage.js
// podmienia zawartość między znacznikami na działający odnośnik.
const MARK_OPEN  = '<!--nav-next-->';
const MARK_CLOSE = '<!--/nav-next-->';
const NEXT_LINK_MARKER = { open: MARK_OPEN, close: MARK_CLOSE };

// ─────────────────────────────────────────────────────────────────────
//  Tekst
// ─────────────────────────────────────────────────────────────────────

/**
 * Escapuje znaki HTML. Używane też w atrybutach, więc bez zamiany
 * końców wiersza na znaczniki.
 */
function esc(text) {
    if (text === null || text === undefined || text === '') return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Zamienia adresy w gotowym, już bezpiecznym tekście na klikalne odnośniki.
 * Działa na tekście po escapowaniu, więc nie da się tędy wstrzyknąć znacznika.
 */
function linkify(escaped) {
    return escaped.replace(/(?:https?:\/\/|www\.)[^\s<]+/gi, (match) => {
        let url  = match;
        let tail = '';

        // Kropka, przecinek albo nawias na końcu zdania nie należą do adresu.
        // Tak samo doklejona encja HTML, na przykład cudzysłów.
        for (;;) {
            const entity = url.match(/&(?:amp|quot|#039|lt|gt);$/);
            if (entity) {
                tail = entity[0] + tail;
                url  = url.slice(0, -entity[0].length);
                continue;
            }
            const punct = url.match(/[.,;:!?)\]}]$/);
            if (punct) {
                tail = punct[0] + tail;
                url  = url.slice(0, -1);
                continue;
            }
            break;
        }

        if (!url) return match;
        const href = url.toLowerCase().startsWith('www.') ? `https://${url}` : url;
        return `<a class="link" href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`;
    });
}

/** Treść wiadomości: escapowanie, klikalne adresy, końce wiersza. */
function fmt(text) {
    return linkify(esc(text)).replace(/\r?\n/g, '<br>');
}

function formatBytes(bytes) {
    if (!bytes || bytes < 0) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TYPE_NAMES = {
    image:         'zdjęcie',
    video:         'film',
    audio:         'nagranie',
    ptt:           'wiadomość głosowa',
    document:      'dokument',
    sticker:       'naklejka',
    location:      'lokalizacja',
    vcard:         'kontakt',
    multi_vcard:   'kontakty',
    poll_creation: 'ankieta',
};

function typeName(type) {
    return TYPE_NAMES[type] || 'plik';
}

// ─────────────────────────────────────────────────────────────────────
//  Daty
// ─────────────────────────────────────────────────────────────────────

function formatTimestamp(ts) {
    return new Date(ts * 1000).toLocaleString('pl-PL', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function formatTime(ts) {
    return new Date(ts * 1000).toLocaleTimeString('pl-PL', {
        hour: '2-digit', minute: '2-digit',
    });
}

function formatDate(ts) {
    return new Date(ts * 1000).toLocaleDateString('pl-PL', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
}

function isoDate(ts) {
    return new Date(ts * 1000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────
//  Ikony (zestaw wbudowany w plik, bez zewnętrznych bibliotek)
// ─────────────────────────────────────────────────────────────────────

const ICON_SPRITE = `
<svg class="sprite" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <symbol id="i-prev" viewBox="0 0 20 20"><path d="M9 4 3.5 10 9 16M3.5 10H17"/></symbol>
    <symbol id="i-next" viewBox="0 0 20 20"><path d="M11 4l5.5 6L11 16M16.5 10H3"/></symbol>
    <symbol id="i-clip" viewBox="0 0 20 20"><path d="M14.6 8.4 8.9 14.1a2.7 2.7 0 0 1-3.8-3.8l6.4-6.4a1.8 1.8 0 0 1 2.6 2.6l-6.4 6.4a.9.9 0 0 1-1.3-1.3l5.7-5.7"/></symbol>
    <symbol id="i-pin" viewBox="0 0 20 20"><path d="M10 17.5s5.2-5 5.2-9a5.2 5.2 0 0 0-10.4 0c0 4 5.2 9 5.2 9Z"/><circle cx="10" cy="8.4" r="1.9"/></symbol>
    <symbol id="i-person" viewBox="0 0 20 20"><circle cx="10" cy="6.8" r="3"/><path d="M4 16.6c0-2.9 2.7-4.6 6-4.6s6 1.7 6 4.6"/></symbol>
    <symbol id="i-poll" viewBox="0 0 20 20"><path d="M5 16V9.5M10 16V4M15 16v-4.5"/></symbol>
    <symbol id="i-trash" viewBox="0 0 20 20"><path d="M3.8 5.6h12.4M8 5.6V3.4h4v2.2M5.6 5.6 6.5 17h7l.9-11.4"/></symbol>
    <symbol id="i-forward" viewBox="0 0 20 20"><path d="M3 16c0-5.2 3.8-7.8 9.5-7.8M9 4.4l4.4 3.8L9 12"/></symbol>
    <symbol id="i-close" viewBox="0 0 20 20"><path d="M5 5l10 10M15 5 5 15"/></symbol>
  </defs>
</svg>`;

function icon(name, extraClass = '') {
    return `<svg class="${('icon ' + extraClass).trim()}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

// ─────────────────────────────────────────────────────────────────────
//  Fragmenty wiadomości
// ─────────────────────────────────────────────────────────────────────

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const VIDEO_EXT = ['mp4', '3gp', 'mov', 'avi', 'webm'];
const AUDIO_EXT = ['ogg', 'mp3', 'opus', 'm4a', 'aac', 'mpeg', 'wav'];

/** Zapisany plik: zdjęcie, film, nagranie albo dokument do pobrania. */
function renderMedia(msg) {
    if (!msg.mediaPath) return '';

    const url = esc(msg.mediaPath.replace(/\\/g, '/'));
    const ext = (msg.mediaPath.split('.').pop() || '').toLowerCase();
    const who = esc(msg.from);

    if (msg.type === 'sticker') {
        return `<figure class="media sticker"><img src="${url}" alt="Naklejka z rozmowy, nadawca: ${who}" loading="lazy"></figure>`;
    }
    if (IMAGE_EXT.includes(ext)) {
        return `<figure class="media">
            <button type="button" class="zoom" data-src="${url}" title="Powiększ zdjęcie">
                <img src="${url}" alt="Zdjęcie z rozmowy, nadawca: ${who}" loading="lazy">
            </button>
        </figure>`;
    }
    if (VIDEO_EXT.includes(ext)) {
        return `<figure class="media">
            <video controls preload="metadata">
                <source src="${url}">
                Twoja przeglądarka nie odtworzy tego filmu. Plik leży w folderze media.
            </video>
        </figure>`;
    }
    if (AUDIO_EXT.includes(ext)) {
        const label = msg.type === 'ptt' ? 'Wiadomość głosowa' : 'Nagranie';
        return `<figure class="media audio">
            <figcaption>${label}</figcaption>
            <audio controls preload="metadata">
                <source src="${url}">
                Twoja przeglądarka nie odtworzy tego nagrania. Plik leży w folderze media.
            </audio>
        </figure>`;
    }

    const name = esc(msg.mediaName || msg.mediaPath.split(/[\\/]/).pop());
    return `<p class="file">${icon('clip')}<a href="${url}" download>${name}</a>
        <span class="mono small">${esc(ext.toUpperCase())}</span></p>`;
}

/** Notatka o pliku, którego nie zapisaliśmy. */
function renderSkipped(msg) {
    if (!msg.mediaSkipped) return '';
    const meta  = msg.mediaSkipped;
    const parts = [typeName(meta.type)];
    if (meta.filename) parts.push(`"${meta.filename}"`);
    const size = formatBytes(meta.bytes);
    if (size) parts.push(size);

    return `<p class="skipped">${icon('clip')}
        <span>Nie zapisano pliku: ${esc(parts.join(', '))}.
        <span class="reason">Powód: ${esc(meta.reason || 'nieznany')}.</span></span></p>`;
}

function renderLocation(msg) {
    if (!msg.location) return '';
    const { latitude, longitude, name, address } = msg.location;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return '';

    const lat = latitude.toFixed(6);
    const lon = longitude.toFixed(6);
    const map = `https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lon}#map=17/${lat}/${lon}`;
    const label = [name, address].filter(Boolean).join(', ') || 'Pokaż na mapie';

    return `<p class="place">${icon('pin')}
        <a class="link" href="${map}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>
        <span class="mono small">${lat}, ${lon}</span></p>`;
}

function renderContacts(msg) {
    if (!msg.contacts || msg.contacts.length === 0) return '';

    const cards = msg.contacts.map((c) => {
        const name = esc(c.name || 'Kontakt bez nazwy');
        const org  = c.org ? `<p class="vcard-org">${esc(c.org)}</p>` : '';
        const nums = (c.numbers || []).length
            ? `<ul class="vcard-tel">${c.numbers.map(n =>
                `<li><a class="link" href="tel:${esc(n.replace(/[^\d+]/g, ''))}">${esc(n)}</a></li>`).join('')}</ul>`
            : '<p class="vcard-org">Brak numeru w wizytówce</p>';
        return `<div class="vcard">${icon('person')}<div><p class="vcard-name">${name}</p>${org}${nums}</div></div>`;
    }).join('');

    return `<div class="vcards">${cards}</div>`;
}

function renderPoll(msg) {
    if (!msg.poll) return '';
    const options = (msg.poll.options || [])
        .map(o => `<li>${esc(o)}</li>`).join('');
    const note = msg.poll.multiple ? '<p class="poll-note">Można wybrać kilka odpowiedzi.</p>' : '';

    return `<div class="poll">
        <p class="poll-head">${icon('poll')}Ankieta</p>
        <p class="poll-q">${fmt(msg.poll.question || 'Pytanie bez treści')}</p>
        ${options ? `<ul class="poll-opts">${options}</ul>` : ''}
        ${note}
        <p class="poll-note">Wyniki głosowania nie są zapisywane.</p>
    </div>`;
}

function renderQuote(msg) {
    if (!msg.quotedMsg) return '';
    return `<blockquote class="quote">
        <p class="quote-who">${esc(msg.quotedMsg.sender)}</p>
        <p class="quote-body">${fmt(msg.quotedMsg.body)}</p>
    </blockquote>`;
}

function renderAvatar(msg) {
    if (msg.fromMe) return '';
    if (msg.avatar) {
        const url = esc(String(msg.avatar).replace(/\\/g, '/'));
        return `<img class="ava" src="${url}" alt="Zdjęcie profilowe: ${esc(msg.from)}" loading="lazy">`;
    }
    const letter = esc((msg.from || '?').trim().charAt(0).toUpperCase() || '?');
    return `<span class="ava ava-blank ${senderTone(msg.from)}" aria-hidden="true">${letter}</span>`;
}

/**
 * Stały kolor imienia nadawcy, liczony z jego nazwy. W grupie każdy ma
 * swój odcień i nie zmienia się on między plikami.
 */
function senderTone(name) {
    const text = String(name || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) % 100000;
    }
    return `n${(hash % 6) + 1}`;
}

/** Pojedynczy wpis w zapisie rozmowy. */
function renderMessage(msg) {
    const own       = msg.fromMe;
    const isDeleted = msg.type === 'revoked' || msg.isDeleted;

    const forwarded = msg.isForwarded
        ? `<p class="flag">${icon('forward')}Przekazana dalej</p>`
        : '';

    // Przy własnych wiadomościach imienia nie piszemy, mówi o tym strona
    // bąbelka i jego kolor.
    const who = own ? '' : `<p class="who ${senderTone(msg.from)}">${esc(msg.from)}</p>`;

    // Przy wizytówce body trzyma surowy vCard, przy ankiecie samo pytanie.
    // Jedno i drugie pokazujemy już rozłożone na części, więc body pomijamy.
    const bodyInside = (msg.contacts && (msg.type === 'vcard' || msg.type === 'multi_vcard'))
        || (msg.poll && msg.type === 'poll_creation');

    const body = msg.body && !bodyInside
        ? `<div class="text">${fmt(msg.body)}</div>`
        : '';

    // Wiadomość, po której nie zostało nic poza typem
    const empty = !msg.body && !msg.mediaPath && !msg.mediaSkipped
        && !msg.location && !msg.contacts && !msg.poll && !isDeleted
        ? `<p class="empty">Wiadomość typu ${esc(TYPE_NAMES[msg.type] || `"${msg.type}"`)}, bez zapisanej treści.</p>`
        : '';

    const deleted = isDeleted
        ? `<p class="gone">${icon('trash')}Skasowana w WhatsAppie. Treść została w archiwum.</p>`
        : '';

    const parts = [
        who,
        forwarded,
        renderQuote(msg),
        renderMedia(msg),
        renderSkipped(msg),
        renderLocation(msg),
        renderContacts(msg),
        renderPoll(msg),
        body,
        empty,
        deleted,
    ].filter(Boolean).join('\n            ');

    return `
    <article class="msg ${own ? 'own' : 'in'}">
        ${renderAvatar(msg)}
        <div class="bubble">
            ${parts}
            <p class="stamp"><time class="mono" datetime="${isoDate(msg.timestamp)}">${formatTime(msg.timestamp)}</time></p>
        </div>
    </article>`;
}

function renderStream(messages) {
    let html = '';
    let lastDate = null;

    for (const msg of messages) {
        const day = formatDate(msg.timestamp);
        if (day !== lastDate) {
            html += `
    <div class="day"><h2>${esc(day)}</h2></div>`;
            lastDate = day;
        }
        html += renderMessage(msg);
    }
    return html;
}

// ─────────────────────────────────────────────────────────────────────
//  Nawigacja
// ─────────────────────────────────────────────────────────────────────

const padded = (n) => String(n).padStart(4, '0');

function buildNextLink(batchNum) {
    return `<a class="pager-link" href="messages_${padded(batchNum)}.html" rel="next">Część ${batchNum}${icon('next')}</a>`;
}

function buildNextDisabled() {
    return `<span class="pager-link off">Dalszych części jeszcze nie ma${icon('next')}</span>`;
}

function buildPrevLink(batchNum) {
    return batchNum > 1
        ? `<a class="pager-link" href="messages_${padded(batchNum - 1)}.html" rel="prev">${icon('prev')}Część ${batchNum - 1}</a>`
        : `<span class="pager-link off">${icon('prev')}To pierwsza część</span>`;
}

// ─────────────────────────────────────────────────────────────────────
//  Cały plik
// ─────────────────────────────────────────────────────────────────────

/**
 * Główna funkcja - generuje kompletny plik HTML z partią wiadomości.
 * totalBatches to numer najnowszej istniejącej części. Gdy równa się
 * batchNum, odnośnik "dalej" jest wyszarzony.
 */

function generateHtml({ chatName, batchNum, messages, totalBatches }) {
    const list       = Array.isArray(messages) ? messages : [];
    const streamHtml = renderStream(list);
    const first      = list.length ? formatTimestamp(list[0].timestamp) : 'brak';
    const last       = list.length ? formatTimestamp(list[list.length - 1].timestamp) : 'brak';
    const monogram   = esc((chatName || '?').trim().charAt(0).toUpperCase() || '?');
    const savedAt    = new Date().toLocaleString('pl-PL', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    const latest   = Number.isFinite(totalBatches) ? totalBatches : batchNum;
    const nextHtml = batchNum < latest ? buildNextLink(batchNum + 1) : buildNextDisabled();
    const nav = (place) => `
    <nav class="pager" aria-label="Nawigacja między częściami zapisu (${place})">
        ${buildPrevLink(batchNum)}
        ${MARK_OPEN}${nextHtml}${MARK_CLOSE}
    </nav>`;

    const retention = config.RETENTION_ENABLED && config.RETENTION_DAYS > 0
        ? `Starsze pliki kasują się po ${config.RETENTION_DAYS} dniach.`
        : 'Kasowanie starych plików jest wyłączone.';

    return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(chatName)}, część ${batchNum}</title>
<style>
:root{
    --deep:#0A1A20;
    --panel:#16303A;
    --mine:#14514A;
    --text:#E4EDEE;
    --dim:#93A9AD;
    --sea:#3FB6A8;
    --edge:rgba(228,237,238,.10);
    --serif:Georgia,'Iowan Old Style','Palatino Linotype','Book Antiqua',serif;
    --sans:'Segoe UI','Noto Sans','Helvetica Neue',Arial,sans-serif;
    --mono:Consolas,'DejaVu Sans Mono','SFMono-Regular',Menlo,monospace;

    /* Kolory imion nadawców, stałe dla danej osoby */
    --n1:#6FD3C4; --n2:#8FBEE8; --n3:#F2B872;
    --n4:#A8D98A; --n5:#E8918A; --n6:#C4A5E0;
}

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

html{-webkit-text-size-adjust:100%}
body{
    background:var(--deep);
    color:var(--text);
    font-family:var(--sans);
    font-size:15.5px;
    line-height:1.55;
    min-height:100vh;
    /* Ledwie widoczna fala, żeby tło nie było płaską płachtą */
    background-image:
        repeating-linear-gradient(115deg,
            rgba(63,182,168,.035) 0 2px,
            transparent 2px 74px);
}
.sheet{max-width:880px;margin:0 auto;padding:0 14px 48px}
.mono{font-family:var(--mono)}
.small{font-size:12px}
.sprite{position:absolute;width:0;height:0;overflow:hidden}

.icon{
    width:1em;height:1em;flex:none;
    fill:none;stroke:currentColor;stroke-width:1.5;
    stroke-linecap:round;stroke-linejoin:round;
    vertical-align:-0.13em;
}

a{color:var(--sea)}
a:hover{color:#68D9CB}
:focus-visible{outline:2px solid var(--sea);outline-offset:2px}

/* ── Pasek czatu, przykleja się przy przewijaniu ── */
.topbar{
    position:sticky;top:0;z-index:10;
    background:rgba(10,26,32,.94);
    border-bottom:1px solid var(--edge);
    margin:0 -14px 14px;
    padding:11px 16px;
    display:flex;align-items:center;gap:13px;
}
.avatar{
    width:44px;height:44px;flex:none;border-radius:50%;
    background:var(--panel);
    border:1px solid var(--edge);
    display:flex;align-items:center;justify-content:center;
    font-family:var(--serif);font-size:20px;color:var(--sea);
}
.topbar h1{
    font-family:var(--serif);font-weight:400;font-size:22px;
    line-height:1.15;word-break:break-word;
}
.topbar .sub{font-size:12px;color:var(--dim);margin-top:3px}
.topbar .sub b{font-weight:600;color:var(--text)}

/* ── Karta z danymi pliku ── */
.facts{
    border:1px solid var(--edge);
    border-left:2px solid var(--sea);
    padding:12px 15px;
    margin-bottom:6px;
    font-size:13px;
    display:grid;gap:5px;
}
.facts div{display:flex;justify-content:space-between;gap:14px}
.facts dt{color:var(--dim)}
.facts dd{font-family:var(--mono);font-size:12.5px;text-align:right}

/* ── Nawigacja ── */
.pager{
    display:flex;justify-content:space-between;align-items:center;
    gap:10px;flex-wrap:wrap;padding:14px 0;
}
.pager-link{
    display:inline-flex;align-items:center;gap:8px;
    font-size:13.5px;text-decoration:none;
    padding:6px 14px;border-radius:18px;
    border:1px solid var(--sea);color:var(--sea);
    transition:background .15s,color .15s;
}
.pager-link:hover{background:var(--sea);color:var(--deep)}
.pager-link.off{
    border-color:rgba(228,237,238,.16);
    color:var(--dim);cursor:default;background:none;
}

/* ── Wiadomości ── */
.stream{padding:2px 0 6px}

.msg{display:flex;align-items:flex-end;gap:9px;margin:9px 0}
.msg.own{justify-content:flex-end}
.msg.in{justify-content:flex-start}

.ava{
    width:30px;height:30px;flex:none;border-radius:50%;
    object-fit:cover;background:var(--panel);
    border:1px solid var(--edge);margin-bottom:2px;
}
.ava-blank{
    display:flex;align-items:center;justify-content:center;
    font-size:13px;font-weight:600;
}

.bubble{
    max-width:min(76%,540px);
    padding:8px 12px 6px;
    border-radius:12px;
    background:var(--panel);
    box-shadow:0 1px 2px rgba(0,0,0,.28);
    word-break:break-word;
}
.msg.in  .bubble{border-bottom-left-radius:3px}
.msg.own .bubble{background:var(--mine);border-bottom-right-radius:3px}

.who{font-size:13px;font-weight:600;margin-bottom:3px}
.n1{color:var(--n1)} .n2{color:var(--n2)} .n3{color:var(--n3)}
.n4{color:var(--n4)} .n5{color:var(--n5)} .n6{color:var(--n6)}

.text{line-height:1.5}
.link{text-underline-offset:2px}

.stamp{text-align:right;margin-top:3px}
.stamp time{font-size:11px;color:var(--dim);letter-spacing:.02em}
.msg.own .stamp time{color:rgba(228,237,238,.62)}

/* ── Separator dnia ── */
.day{display:flex;justify-content:center;margin:22px 0 14px}
.day h2{
    font-family:var(--serif);font-weight:400;font-size:13.5px;
    color:var(--dim);
    background:rgba(22,48,58,.85);
    border:1px solid var(--edge);
    border-radius:14px;
    padding:4px 15px;
}

/* ── Cytat ── */
.quote{
    background:rgba(10,26,32,.42);
    border-left:3px solid var(--sea);
    border-radius:5px;
    padding:5px 10px;margin-bottom:6px;
}
.msg.own .quote{border-left-color:var(--n1)}
.quote-who{font-size:12.5px;font-weight:600;color:var(--sea)}
.msg.own .quote-who{color:var(--n1)}
.quote-body{font-size:12.5px;color:var(--dim);line-height:1.4}

/* ── Media ── */
.media{margin:2px 0 6px}
.media img,.media video{
    display:block;max-width:min(100%,320px);height:auto;
    border-radius:7px;background:rgba(10,26,32,.5);
}
.media.sticker img{max-width:118px;background:none}
.zoom{display:block;padding:0;border:0;background:none;cursor:zoom-in;font:inherit}
.media.audio figcaption{font-size:11.5px;color:var(--dim);margin-bottom:4px}
.media audio{width:100%;max-width:300px;display:block}

.file{
    display:flex;align-items:center;gap:9px;
    background:rgba(10,26,32,.42);border-radius:7px;
    padding:9px 11px;margin:2px 0 6px;font-size:14px;
}
.file .small{color:var(--dim);font-size:11px}

.skipped{
    display:flex;gap:9px;
    border:1px dashed rgba(228,237,238,.22);
    border-radius:7px;padding:8px 11px;margin:2px 0 6px;
    font-size:13px;color:var(--dim);line-height:1.4;
}
.skipped .reason{display:block;font-size:12px}

.place{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    margin:2px 0 6px;font-size:14px;
}
.place .small{color:var(--dim)}

.vcards{margin:2px 0 6px;display:grid;gap:7px}
.vcard{
    display:flex;gap:10px;
    background:rgba(10,26,32,.42);
    border-radius:7px;padding:10px 12px;
}
.vcard .icon{width:19px;height:19px;color:var(--dim);margin-top:2px}
.vcard-name{font-weight:600;font-size:14px}
.vcard-org{font-size:12.5px;color:var(--dim)}
.vcard-tel{list-style:none;font-size:13.5px;font-family:var(--mono);margin-top:2px}

.poll{
    background:rgba(10,26,32,.42);
    border-radius:7px;padding:11px 13px;margin:2px 0 6px;
}
.poll-head{
    display:flex;align-items:center;gap:7px;
    font-size:11px;letter-spacing:.12em;text-transform:uppercase;
    color:var(--dim);font-family:var(--mono);
}
.poll-q{font-weight:600;margin:6px 0 8px;font-size:14.5px}
.poll-opts{list-style:none;font-size:14px}
.poll-opts li{
    padding:6px 0 6px 18px;position:relative;
    border-top:1px solid var(--edge);
}
.poll-opts li::before{
    content:"";position:absolute;left:0;top:12px;
    width:9px;height:9px;border-radius:50%;
    border:1px solid var(--dim);
}
.poll-note{font-size:11.5px;color:var(--dim);margin-top:7px}

.flag{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim);margin-bottom:4px}
.empty{font-size:13px;color:var(--dim);font-style:italic}
.gone{
    display:flex;align-items:center;gap:7px;
    margin-top:6px;padding-top:6px;
    border-top:1px solid var(--edge);
    font-size:12.5px;color:#F08A7C;
}

/* ── Stopka ── */
.colophon{
    margin-top:22px;padding-top:13px;
    border-top:1px solid var(--edge);
    font-size:12px;color:var(--dim);max-width:66ch;
}
.colophon p+p{margin-top:4px}

/* ── Podgląd zdjęcia ── */
.lightbox{
    display:none;position:fixed;inset:0;z-index:60;
    background:rgba(5,14,18,.95);
    padding:24px;align-items:center;justify-content:center;
}
.lightbox.on{display:flex}
.lightbox img{max-width:94vw;max-height:88vh;border-radius:6px}
.lb-close{
    position:fixed;top:14px;right:16px;
    width:40px;height:40px;
    display:flex;align-items:center;justify-content:center;
    background:none;border:1px solid rgba(228,237,238,.35);
    border-radius:50%;color:var(--text);cursor:pointer;
}
.lb-close .icon{width:20px;height:20px}
.lb-close:hover{border-color:var(--sea);color:var(--sea)}

@media (min-width:720px){
    .sheet{padding:0 20px 60px}
    .topbar{margin:0 -20px 16px;padding:13px 22px}
    .topbar h1{font-size:26px}
    .avatar{width:50px;height:50px;font-size:23px}
    .bubble{max-width:min(68%,520px);font-size:15.5px}
    .facts{grid-template-columns:1fr 1fr;column-gap:26px}
}

@media (prefers-reduced-motion:reduce){
    *{transition:none!important;animation:none!important;scroll-behavior:auto!important}
}

/* Wydruk na jasno, ciemne tło zjadałoby toner */
@media print{
    body{background:#fff;background-image:none;color:#111;font-size:11pt}
    .topbar{position:static;background:none;border-color:#ccc}
    .topbar h1,.avatar{color:#111}
    .avatar{background:#eee;border-color:#ccc}
    .bubble{background:#f2f2f2!important;box-shadow:none;border:1px solid #ddd}
    .msg.own .bubble{background:#e6f0ee!important}
    .who,.quote-who{color:#222!important}
    .stamp time,.colophon,.skipped,.poll-note{color:#555!important}
    .pager,.lightbox,.lb-close,.zoom{display:none!important}
    .media img{max-width:60mm}
    .msg{page-break-inside:avoid}
}
</style>
</head>
<body>
${ICON_SPRITE}

<div class="sheet">

    <header class="topbar">
        <div class="avatar" aria-hidden="true">${monogram}</div>
        <div>
            <h1>${esc(chatName)}</h1>
            <p class="sub">Zapis rozmowy, część <b>${batchNum}</b> &nbsp;&middot;&nbsp; ${list.length} wiadomości</p>
        </div>
    </header>

    <dl class="facts">
        <div><dt>Pierwsza wiadomość</dt><dd>${esc(first)}</dd></div>
        <div><dt>Ostatnia wiadomość</dt><dd>${esc(last)}</dd></div>
        <div><dt>Plik zapisano</dt><dd>${esc(savedAt)}</dd></div>
        <div><dt>Media</dt><dd>folder media</dd></div>
    </dl>

    ${nav('góra strony')}

    <main class="stream">
        ${streamHtml || '<p class="empty">Ta część nie zawiera wiadomości.</p>'}
    </main>

    ${nav('dół strony')}

    <footer class="colophon">
        <p>Plik powstaje automatycznie i zamyka się co ${config.MESSAGES_PER_FILE} wiadomości. ${esc(retention)}</p>
        <p>Godziny pokazujemy w strefie czasowej komputera, który zapisywał rozmowę.
        Program nie wie, czy wiadomość została przeczytana, więc tego nie pokazuje.</p>
    </footer>

</div>

<div class="lightbox" id="lightbox" hidden>
    <button type="button" class="lb-close" id="lbClose" title="Zamknij podgląd" aria-label="Zamknij podgląd">${icon('close')}</button>
    <img id="lbImg" src="" alt="Powiększone zdjęcie z rozmowy">
</div>

<script>
(function () {
    var box    = document.getElementById('lightbox');
    var img    = document.getElementById('lbImg');
    var close  = document.getElementById('lbClose');
    var opener = null;

    function open(button) {
        opener = button;
        img.src = button.getAttribute('data-src');
        box.hidden = false;
        box.classList.add('on');
        close.focus();
    }
    function shut() {
        box.classList.remove('on');
        box.hidden = true;
        img.src = '';
        if (opener) { opener.focus(); opener = null; }
    }

    document.querySelectorAll('.zoom').forEach(function (btn) {
        btn.addEventListener('click', function () { open(btn); });
    });
    close.addEventListener('click', shut);
    box.addEventListener('click', function (e) { if (e.target === box) shut(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !box.hidden) shut();
    });
})();
</script>

</body>
</html>`;
}

module.exports = { generateHtml, NEXT_LINK_MARKER, buildNextLink };
