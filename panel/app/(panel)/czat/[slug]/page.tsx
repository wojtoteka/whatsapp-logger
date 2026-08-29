import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fromSlug, loadChat, loadMessages } from '@/lib/archiwum';
import { formatDate, formatDateTime, messageCount } from '@/lib/format';
import { Awatar } from '@/components/Awatar';
import { MaterialIcon } from '@/components/MaterialIcon';
import { Wiadomosc } from '@/components/Wiadomosc';

export const dynamic = 'force-dynamic';

/** Ile wiadomości na jednej stronie. */
const NA_STRONE = 60;

interface Props {
    params: Promise<{ slug: string }>;
    searchParams: Promise<{ strona?: string }>;
}

export async function generateMetadata({ params }: Props) {
    const { slug } = await params;
    const chat = await loadChat(fromSlug(slug));
    return { title: chat ? `${chat.name} - Archiwum WhatsApp` : 'Archiwum WhatsApp' };
}

export default async function StronaCzatu({ params, searchParams }: Props) {
    const { slug } = await params;
    const { strona } = await searchParams;

    const folder = fromSlug(slug);
    const chat = await loadChat(folder);
    if (!chat) notFound();

    const page = Math.max(1, Number.parseInt(strona ?? '1', 10) || 1);
    const { messages, hasOlder } = await loadMessages(folder, {
        limit: NA_STRONE,
        offset: (page - 1) * NA_STRONE,
    });

    const wrocDo = chat.isStatus ? '/relacje' : '/';

    return (
        <main>
            <Link className="back" href={wrocDo}>
                <MaterialIcon name="arrowBack" />
                <span>{chat.isStatus ? 'Wszystkie relacje' : 'Wszystkie rozmowy'}</span>
            </Link>

            <header className="chat-head">
                <Awatar path={chat.avatar} name={chat.name} size="lg" />
                <div>
                    <h1>{chat.name}</h1>
                    <p className="sub">
                        {chat.isStatus ? 'Relacje · ' : ''}
                        {messageCount(chat.messageCount)}
                        {chat.lastMessageAt ? ` · ostatnia ${formatDateTime(chat.lastMessageAt)}` : ''}
                        {page > 1 ? ` · strona ${page}` : ''}
                    </p>
                </div>
            </header>

            {messages.length === 0 ? (
                <div className="empty-state">
                    <h2>Ta strona jest pusta</h2>
                    <div>W archiwum nie ma tylu wiadomości. Wróć na pierwszą stronę.</div>
                </div>
            ) : (
                <>
                    <p className="notice">
                        Najnowsze wiadomości są na górze. Im niżej, tym starsze - a starsze niż ta strona
                        czekają pod „Starsze wiadomości".
                    </p>
                    <Strumien folder={folder} messages={messages} />
                </>
            )}

            <nav className="pager" aria-label="Nawigacja między stronami">
                {page > 1 ? (
                    <Link href={`/czat/${slug}?strona=${page - 1}`}>
                        <MaterialIcon name="arrowBack" />
                        <span>Nowsze wiadomości</span>
                    </Link>
                ) : (
                    <span>To najnowsze wiadomości</span>
                )}

                {hasOlder ? (
                    <Link href={`/czat/${slug}?strona=${page + 1}`}>
                        <span>Starsze wiadomości</span>
                        <MaterialIcon name="arrowForward" />
                    </Link>
                ) : (
                    <span>To początek archiwum</span>
                )}
            </nav>
        </main>
    );
}

/**
 * Wiadomości od najnowszej, z nagłówkiem dnia przy każdej zmianie daty.
 * Idziemy w dół, więc data też cofa się w dół - dlatego separator wchodzi
 * przed pierwszą wiadomością z danego dnia, licząc od góry.
 */
function Strumien({
    folder,
    messages,
}: {
    folder: string;
    messages: Awaited<ReturnType<typeof loadMessages>>['messages'];
}) {
    let lastDay: string | null = null;

    return (
        <div className="stream">
            {messages.map((message) => {
                const day = formatDate(message.timestamp);
                const newDay = day !== lastDay;
                lastDay = day;

                return (
                    <div key={message.id}>
                        {newDay && <div className="day-sep">{day}</div>}
                        <Wiadomosc message={message} folder={folder} />
                    </div>
                );
            })}
        </div>
    );
}
