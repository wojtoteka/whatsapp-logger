import { listChats, logsDir } from '@/lib/archiwum';
import { ListaCzatow } from '@/components/ListaCzatow';
import { messageCount } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function StronaGlowna() {
    const { rozmowy } = await listChats();
    const razem = rozmowy.reduce((sum, chat) => sum + chat.messageCount, 0);

    return (
        <main>
            <h1 className="page-title">Rozmowy</h1>
            <p className="page-sub">
                {rozmowy.length > 0
                    ? `${rozmowy.length} ${rozmowy.length === 1 ? 'czat' : 'czatów'} · ${messageCount(razem)} · od najnowszych`
                    : 'Archiwum jest jeszcze puste.'}
            </p>

            <ListaCzatow
                chats={rozmowy}
                empty={{
                    title: 'Nie ma jeszcze żadnej rozmowy',
                    hint: (
                        <>
                            Panel czyta archiwum z folderu <code>{logsDir()}</code>.
                            <br />
                            Uruchom loggera i poczekaj na pierwszą wiadomość - pojawi się tutaj sama.
                        </>
                    ),
                }}
            />
        </main>
    );
}
