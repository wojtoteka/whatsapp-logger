import { messageCount, relativeDay } from '@/lib/format';
import type { ChatSummary } from '@/lib/typy';
import { SzukajkaCzatow } from './SzukajkaCzatow';
import type { KartaCzatu, TekstySzukania } from './SzukajkaCzatow';

interface Props {
    chats: ChatSummary[];
    /** Teksty wyszukiwarki - inne dla rozmów, inne dla relacji. */
    search: TekstySzukania;
    /** Co pokazać, gdy nie ma jeszcze żadnego czatu. */
    empty: { title: string; hint: React.ReactNode };
}

export function ListaCzatow({ chats, search, empty }: Props) {
    if (chats.length === 0) {
        return (
            <div className="empty-state">
                <h2>{empty.title}</h2>
                <div>{empty.hint}</div>
            </div>
        );
    }

    // Daty i odmiany zamieniamy na gotowe napisy tutaj, bo filtrowanie listy
    // dzieje się już w przeglądarce - patrz komentarz przy KartaCzatu.
    const cards: KartaCzatu[] = chats.map((chat) => ({
        folder: chat.folder,
        slug: chat.slug,
        name: chat.name,
        avatar: chat.avatar,
        preview: chat.preview,
        when: relativeDay(chat.lastMessageAt),
        meta: messageCount(chat.messageCount),
    }));

    return <SzukajkaCzatow chats={cards} search={search} />;
}
