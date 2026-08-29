import Link from 'next/link';
import { messageCount, relativeDay } from '@/lib/format';
import type { ChatSummary } from '@/lib/typy';
import { Awatar } from './Awatar';

interface Props {
    chats: ChatSummary[];
    /** Co pokazać, gdy nie ma jeszcze żadnego czatu. */
    empty: { title: string; hint: React.ReactNode };
}

export function ListaCzatow({ chats, empty }: Props) {
    if (chats.length === 0) {
        return (
            <div className="empty-state">
                <h2>{empty.title}</h2>
                <div>{empty.hint}</div>
            </div>
        );
    }

    return (
        <div className="chat-grid">
            {chats.map((chat) => (
                <Link key={chat.folder} className="chat-card" href={`/czat/${chat.slug}`}>
                    <Awatar path={chat.avatar} name={chat.name} size="md" />

                    <div className="body">
                        <div className="row">
                            <span className="name">{chat.name}</span>
                            <span className="when">{relativeDay(chat.lastMessageAt)}</span>
                        </div>
                        {chat.preview && <div className="preview">{chat.preview}</div>}
                        <div className="meta">{messageCount(chat.messageCount)}</div>
                    </div>
                </Link>
            ))}
        </div>
    );
}
