// Generator plików HTML z wiadomościami WhatsApp

/**
 * Escapuje znaki HTML, aby zapobiec problemom z wyświetlaniem
 * i ewentualnym wstrzyknięciom treści.
 */
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '<br>');
}

/**
 * Formatuje timestamp UNIX do czytelnej daty i godziny po polsku.
 */
function formatTimestamp(ts) {
    const date = new Date(ts * 1000);
    return date.toLocaleString('pl-PL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/**
 * Formatuje timestamp do samej daty (dla separatorów dni).
 */
function formatDate(ts) {
    const date = new Date(ts * 1000);
    return date.toLocaleDateString('pl-PL', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
}

/**
 * Generuje HTML dla osadzonych mediów (zdjęcia, wideo, audio, pliki).
 */
function renderMedia(msg) {
    if (!msg.mediaPath) return '';

    // Normalizuj separator ścieżki dla przeglądarki
    const mediaUrl = msg.mediaPath.replace(/\\/g, '/');
    const ext = (mediaUrl.split('.').pop() || '').toLowerCase();

    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const videoExts = ['mp4', '3gp', 'mov', 'avi'];
    const audioExts = ['ogg', 'mp3', 'opus', 'm4a', 'aac'];

    if (imageExts.includes(ext)) {
        return `<div class="media">
            <img src="${mediaUrl}" alt="Zdjęcie" loading="lazy" onclick="openLightbox(this.src)" title="Kliknij, aby powiększyć">
        </div>`;
    }
    if (videoExts.includes(ext)) {
        return `<div class="media">
            <video controls preload="metadata">
                <source src="${mediaUrl}">
                Twoja przeglądarka nie obsługuje odtwarzania wideo.
            </video>
        </div>`;
    }
    if (audioExts.includes(ext)) {
        return `<div class="media">
            <audio controls>
                <source src="${mediaUrl}">
                Twoja przeglądarka nie obsługuje odtwarzania audio.
            </audio>
        </div>`;
    }
    // Pozostałe pliki (dokumenty itp.)
    return `<div class="media file">
        <a href="${mediaUrl}" download>📎 Pobierz plik (${ext.toUpperCase()})</a>
    </div>`;
}

/**
 * Generuje HTML dla pojedynczej wiadomości.
 */
function renderMessage(msg) {
    const direction = msg.fromMe ? 'sent' : 'received';
    const time = formatTimestamp(msg.timestamp);

    // Treść wiadomości
    const isDeleted = msg.type === 'revoked' || msg.isDeleted;
    let bodyHtml = '';
    if (msg.body) {
        bodyHtml = `<div class="body">${escapeHtml(msg.body)}</div>`;
    }
    // Baner skasowania – dołączany na dole bąbelka
    const deletedBanner = isDeleted
        ? `<div class="deleted-banner">🗑 Wiadomość skasowana</div>`
        : '';

    // Cytowana wiadomość
    const quotedHtml = msg.quotedMsg
        ? `<div class="quoted">
               <span class="quoted-sender">${escapeHtml(msg.quotedMsg.sender)}</span>
               <span class="quoted-body">${escapeHtml(msg.quotedMsg.body)}</span>
           </div>`
        : '';

    // Podpis pod zdjęciem/filmem
    const captionHtml = msg.caption
        ? `<div class="caption">${escapeHtml(msg.caption)}</div>`
        : '';

    // Przekazana wiadomość
    const forwardedHtml = msg.isForwarded
        ? `<div class="forwarded">↪ Wiadomość przekazana</div>`
        : '';

    // Imię nadawcy (tylko w wiadomościach odebranych, dla grupowych)
    const senderHtml = !msg.fromMe
        ? `<div class="sender-name">${escapeHtml(msg.from)}</div>`
        : '';

    // Znacznik przeczytania dla wysłanych
    const readTick = msg.fromMe ? ' ✓✓' : '';

    return `
    <div class="message ${direction}">
        <div class="bubble ${direction}">
            ${forwardedHtml}
            ${senderHtml}
            ${quotedHtml}
            ${renderMedia(msg)}
            ${captionHtml}
            ${bodyHtml}
            ${deletedBanner}
            <div class="timestamp">${time}${readTick}</div>
        </div>
    </div>`;
}

/**
 * Generuje listę wiadomości z separatorami dat.
 */
function renderMessages(messages) {
    let html = '';
    let lastDate = null;

    for (const msg of messages) {
        const msgDate = formatDate(msg.timestamp);
        if (msgDate !== lastDate) {
            html += `
    <div class="date-separator"><span>${msgDate}</span></div>`;
            lastDate = msgDate;
        }
        html += renderMessage(msg);
    }
    return html;
}

/**
 * Główna funkcja – generuje kompletny plik HTML z partią wiadomości.
 */
function generateHtml({ chatName, batchNum, messages, totalBatches }) {
    const messagesHtml = renderMessages(messages);
    const startDate = messages.length > 0 ? formatTimestamp(messages[0].timestamp) : '–';
    const endDate   = messages.length > 0 ? formatTimestamp(messages[messages.length - 1].timestamp) : '–';
    const avatarLetter = escapeHtml((chatName || '?').charAt(0).toUpperCase());

    const padded = (n) => String(n).padStart(4, '0');
    const prevLink = batchNum > 1
        ? `<a href="messages_${padded(batchNum - 1)}.html">← Część ${batchNum - 1}</a>`
        : '<span class="nav-disabled">← Część poprzednia</span>';
    const nextLink = `<a href="messages_${padded(batchNum + 1)}.html">Część ${batchNum + 1} →</a>`;

    const navHtml = `<div class="nav">${prevLink}${nextLink}</div>`;

    return `<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(chatName)} – Część ${batchNum}</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            background-color: #0b141a;
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
            color: #e9edef;
            min-height: 100vh;
            padding: 16px;
        }

        .container { max-width: 860px; margin: 0 auto; }

        /* Nagłówek czatu */
        .chat-header {
            background: #202c33;
            padding: 14px 18px;
            border-radius: 10px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 14px;
        }
        .chat-avatar {
            width: 48px; height: 48px;
            background: #00a884;
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 22px; font-weight: bold; color: #fff;
            flex-shrink: 0;
        }
        .chat-info h1 { font-size: 17px; color: #e9edef; }
        .chat-info p  { font-size: 12px; color: #8696a0; margin-top: 4px; }

        /* Nawigacja */
        .nav {
            text-align: center;
            padding: 10px 0;
            margin: 12px 0;
        }
        .nav a, .nav-disabled {
            display: inline-block;
            padding: 7px 18px;
            margin: 0 6px;
            border-radius: 20px;
            font-size: 13px;
            text-decoration: none;
        }
        .nav a {
            color: #00a884;
            border: 1px solid #00a884;
            transition: background 0.2s, color 0.2s;
        }
        .nav a:hover { background: #00a884; color: #fff; }
        .nav-disabled { color: #3d5a65; border: 1px solid #3d5a65; cursor: default; }

        /* Wiadomości */
        .messages { padding: 8px 0; }

        .message {
            display: flex;
            padding: 2px 8px;
            margin: 2px 0;
        }
        .message.sent     { justify-content: flex-end; }
        .message.received { justify-content: flex-start; }

        .bubble {
            max-width: 65%;
            min-width: 80px;
            padding: 6px 10px 8px 10px;
            border-radius: 8px;
            word-break: break-word;
            position: relative;
        }
        .bubble.sent {
            background: #005c4b;
            color: #e9edef;
            border-bottom-right-radius: 2px;
        }
        .bubble.received {
            background: #202c33;
            color: #e9edef;
            border-bottom-left-radius: 2px;
        }

        .sender-name {
            color: #53bdeb;
            font-size: 12.5px;
            font-weight: 600;
            margin-bottom: 3px;
        }

        .body { font-size: 14px; line-height: 1.45; }
        .body.deleted { font-style: italic; color: #8696a0; }

        .deleted-banner {
            margin-top: 6px;
            padding: 4px 8px;
            background: rgba(220, 38, 38, 0.15);
            border-left: 3px solid #dc2626;
            border-radius: 4px;
            color: #f87171;
            font-size: 12px;
            font-style: italic;
        }

        .timestamp {
            font-size: 11px;
            color: #8696a0;
            text-align: right;
            margin-top: 5px;
            user-select: none;
        }

        .forwarded {
            font-size: 11px;
            color: #8696a0;
            margin-bottom: 4px;
        }

        /* Cytowana wiadomość */
        .quoted {
            background: rgba(0,0,0,0.25);
            border-left: 3px solid #00a884;
            border-radius: 4px;
            padding: 4px 8px;
            margin-bottom: 6px;
        }
        .quoted-sender {
            color: #00a884;
            font-size: 12px;
            font-weight: 600;
            display: block;
            margin-bottom: 2px;
        }
        .quoted-body { font-size: 12px; color: #8696a0; }

        /* Media */
        .media { margin: 4px 0; }
        .media img {
            max-width: 300px;
            max-height: 300px;
            border-radius: 6px;
            cursor: pointer;
            display: block;
        }
        .media video {
            max-width: 300px;
            border-radius: 6px;
            display: block;
        }
        .media audio {
            width: 100%;
            max-width: 280px;
            display: block;
        }
        .media.file a { color: #53bdeb; text-decoration: none; font-size: 13px; }
        .media.file a:hover { text-decoration: underline; }

        .caption { font-size: 13px; margin-top: 4px; }

        /* Separator dat */
        .date-separator {
            text-align: center;
            margin: 16px 0 12px;
            color: #8696a0;
            font-size: 12px;
        }
        .date-separator span {
            background: #182229;
            padding: 4px 14px;
            border-radius: 10px;
            border: 1px solid #2a3942;
        }

        /* Lightbox */
        #lightbox {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.92);
            z-index: 9999;
            align-items: center;
            justify-content: center;
        }
        #lightbox.active { display: flex; }
        #lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 4px; }
        #lb-close {
            position: fixed;
            top: 18px; right: 22px;
            color: #fff;
            font-size: 32px;
            cursor: pointer;
            line-height: 1;
            user-select: none;
        }
        #lb-close:hover { color: #ccc; }
    </style>
</head>
<body>

<div id="lightbox" onclick="closeLightbox()">
    <span id="lb-close" title="Zamknij">✕</span>
    <img id="lb-img" src="" alt="Podgląd">
</div>

<div class="container">

    <div class="chat-header">
        <div class="chat-avatar">${avatarLetter}</div>
        <div class="chat-info">
            <h1>${escapeHtml(chatName)}</h1>
            <p>Część ${batchNum} &nbsp;•&nbsp; ${startDate} – ${endDate} &nbsp;•&nbsp; ${messages.length} wiadomości</p>
        </div>
    </div>

    ${navHtml}

    <div class="messages">
        ${messagesHtml}
    </div>

    ${navHtml}

</div>

<script>
    function openLightbox(src) {
        document.getElementById('lb-img').src = src;
        document.getElementById('lightbox').classList.add('active');
    }
    function closeLightbox() {
        document.getElementById('lightbox').classList.remove('active');
        document.getElementById('lb-img').src = '';
    }
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeLightbox();
    });
</script>

</body>
</html>`;
}

module.exports = { generateHtml };
