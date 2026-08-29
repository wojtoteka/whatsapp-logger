import { listChats, logsDir } from '@/lib/archiwum';
import { ListaCzatow } from '@/components/ListaCzatow';
import { messageCount } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata = {
    title: 'Relacje - Archiwum WhatsApp',
};

export default async function StronaRelacji() {
    const { relacje } = await listChats();
    const razem = relacje.reduce((sum, chat) => sum + chat.messageCount, 0);

    return (
        <main>
            <h1 className="page-title">Relacje</h1>
            <p className="page-sub">
                {relacje.length > 0
                    ? `${relacje.length} ${relacje.length === 1 ? 'autor' : 'autorów'} · ${messageCount(razem)} · od najnowszych`
                    : 'Nie ma jeszcze żadnej zapisanej relacji.'}
            </p>

            <ListaCzatow
                chats={relacje}
                empty={{
                    title: 'Nie ma jeszcze żadnej relacji',
                    hint: (
                        <>
                            Relacje trafiają do <code>{logsDir()}/Statusy</code>, każdy autor do swojego
                            podfolderu.
                            <br />
                            Logger zbiera je na bieżąco i dodatkowo co kilka godzin dobiera te, które
                            pojawiły się, gdy był wyłączony.
                        </>
                    ),
                }}
            />
        </main>
    );
}
