import { fileUrl, toArchivePath } from '@/lib/archiwum';
import { formatBytes, formatTime, isoDate, mediaKind, senderTone, typeName } from '@/lib/format';
import type { ArchivedMessage } from '@/lib/typy';
import { Awatar } from './Awatar';
import { Tresc } from './Tresc';

interface Props {
    message: ArchivedMessage;
    /** Folder czatu - ścieżki mediów są liczone względem niego. */
    folder: string;
}

export function Wiadomosc({ message, folder }: Props) {
    const own = message.fromMe;
    const deleted = message.isDeleted || message.type === 'revoked';

    // Przy wizytówce treść trzyma surowy vCard, przy ankiecie samo pytanie -
    // pokazujemy je rozłożone na części, więc treści nie powtarzamy.
    const bodyInside =
        (message.contacts && (message.type === 'vcard' || message.type === 'multi_vcard')) ||
        (message.poll && message.type === 'poll_creation');

    return (
        <article className={`msg ${own ? 'own' : 'in'}`}>
            {!own && <Awatar path={toArchivePath(folder, message.avatar)} name={message.from} size="sm" />}

            <div className="bubble">
                {!own && <p className={`who ${senderTone(message.from)}`}>{message.from}</p>}

                {message.isForwarded && <p className="flag">↪ Przekazana dalej</p>}

                {message.quotedMsg && (
                    <blockquote className="quote">
                        <p className="quote-who">{message.quotedMsg.sender}</p>
                        <p className="quote-body">{message.quotedMsg.body}</p>
                    </blockquote>
                )}

                <Media message={message} folder={folder} />
                <Pominiete message={message} />
                <Lokalizacja message={message} />
                <Wizytowki message={message} />
                <Ankieta message={message} />

                {message.body && !bodyInside && (
                    <div className="text">
                        <Tresc text={message.body} />
                    </div>
                )}

                {deleted && <p className="gone">🗑 Skasowana w WhatsAppie. Treść została w archiwum.</p>}

                <p className="stamp">
                    <time dateTime={isoDate(message.timestamp)}>{formatTime(message.timestamp)}</time>
                </p>
            </div>
        </article>
    );
}

function Media({ message, folder }: Props) {
    if (!message.mediaPath) return null;

    const url = fileUrl(toArchivePath(folder, message.mediaPath));
    if (!url) return null;

    const kind = mediaKind(message.mediaPath, message.type);

    if (kind === 'image') {
        return (
            <figure className={`media ${message.type === 'sticker' ? 'sticker' : ''}`}>
                <a href={url} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`Załącznik od: ${message.from}`} loading="lazy" />
                </a>
            </figure>
        );
    }
    if (kind === 'video') {
        return (
            <figure className="media">
                <video controls preload="metadata" src={url} />
            </figure>
        );
    }
    if (kind === 'audio') {
        return (
            <figure className="media">
                <figcaption>{message.type === 'ptt' ? 'Wiadomość głosowa' : 'Nagranie'}</figcaption>
                <audio controls preload="metadata" src={url} />
            </figure>
        );
    }

    const name = message.mediaName ?? message.mediaPath.split(/[\\/]/).pop();
    return (
        <p className="file-link">
            📎{' '}
            <a href={url} download>
                {name}
            </a>
        </p>
    );
}

function Pominiete({ message }: { message: ArchivedMessage }) {
    if (!message.mediaSkipped) return null;

    const meta = message.mediaSkipped;
    const parts = [typeName(meta.type)];
    if (meta.filename) parts.push(`"${meta.filename}"`);

    const size = formatBytes(meta.bytes);
    if (size) parts.push(size);

    return (
        <p className="skipped">
            📎 Nie zapisano pliku: {parts.join(', ')}.<br />
            Powód: {meta.reason || 'nieznany'}.
        </p>
    );
}

function Lokalizacja({ message }: { message: ArchivedMessage }) {
    const loc = message.location;
    if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return null;

    const lat = loc.latitude.toFixed(6);
    const lon = loc.longitude.toFixed(6);
    const label = [loc.name, loc.address].filter(Boolean).join(', ') || 'Pokaż na mapie';

    return (
        <p className="card-inline">
            <span className="label">Lokalizacja</span>
            <a
                href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`}
                target="_blank"
                rel="noopener noreferrer"
            >
                {label}
            </a>
            <br />
            <span className="mono" style={{ fontSize: 11.5, opacity: 0.7 }}>
                {lat}, {lon}
            </span>
        </p>
    );
}

function Wizytowki({ message }: { message: ArchivedMessage }) {
    if (!message.contacts || message.contacts.length === 0) return null;

    return (
        <div className="card-inline">
            <span className="label">Wizytówka</span>
            {message.contacts.map((contact, index) => (
                <div key={index} style={{ marginTop: index > 0 ? 8 : 0 }}>
                    <strong>{contact.name ?? 'Kontakt bez nazwy'}</strong>
                    {contact.org && (
                        <div style={{ fontSize: 12.5, opacity: 0.75 }}>{contact.org}</div>
                    )}
                    {contact.numbers.length > 0 ? (
                        contact.numbers.map((numer) => (
                            <div key={numer} className="mono" style={{ fontSize: 13 }}>
                                <a href={`tel:${numer.replace(/[^\d+]/g, '')}`}>{numer}</a>
                            </div>
                        ))
                    ) : (
                        <div style={{ fontSize: 12.5, opacity: 0.75 }}>Brak numeru w wizytówce</div>
                    )}
                </div>
            ))}
        </div>
    );
}

function Ankieta({ message }: { message: ArchivedMessage }) {
    if (!message.poll) return null;

    return (
        <div className="card-inline">
            <span className="label">Ankieta</span>
            <strong>{message.poll.question ?? 'Pytanie bez treści'}</strong>
            {message.poll.options.length > 0 && (
                <ul>
                    {message.poll.options.map((opcja) => (
                        <li key={opcja}>{opcja}</li>
                    ))}
                </ul>
            )}
            <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 6 }}>
                {message.poll.multiple ? 'Można wybrać kilka odpowiedzi. ' : ''}
                Wyniki głosowania nie są zapisywane.
            </div>
        </div>
    );
}
