import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { listChats } from '@/lib/archiwum';
import { acknowledgeTauJob, createTauJob, readTauJob, tauEnabled } from '@/lib/tau';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    const user = await currentUser();
    if (!user) return jsonError('Zaloguj się ponownie.', 401);
    if (!tauEnabled()) return jsonError('?tau jest wyłączone w konfiguracji loggera.', 503);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        return jsonError('Endpoint przyjmuje wyłącznie JSON.', 415);
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return jsonError('Nieprawidłowe dane zapytania.', 400);
    }
    const data = body as { folder?: unknown; question?: unknown };
    const folder = typeof data.folder === 'string' ? data.folder : '';
    const question = typeof data.question === 'string' ? data.question.trim() : '';
    if (!question) return jsonError('Pytanie nie może być puste.', 400);
    if (question.length > 4000) return jsonError('Pytanie może mieć najwyżej 4000 znaków.', 400);

    const { rozmowy } = await listChats();
    if (!rozmowy.some((chat) => chat.folder === folder)) {
        return jsonError('Nie znaleziono wskazanej rozmowy.', 404);
    }

    try {
        const id = await createTauJob(folder, question, user);
        return NextResponse.json({ id, status: 'pending' }, { status: 202 });
    } catch (error) {
        return jsonError(error instanceof Error ? error.message : 'Nie udało się utworzyć zapytania.', 429);
    }
}

export async function GET(request: Request) {
    const user = await currentUser();
    if (!user) return jsonError('Zaloguj się ponownie.', 401);
    const id = new URL(request.url).searchParams.get('id') ?? '';
    const result = await readTauJob(id, user);
    if (!result) return jsonError('Nie znaleziono tego zapytania.', 404);
    return NextResponse.json(result, {
        headers: { 'Cache-Control': 'no-store' },
    });
}

export async function DELETE(request: Request) {
    const user = await currentUser();
    if (!user) return jsonError('Zaloguj się ponownie.', 401);
    const id = new URL(request.url).searchParams.get('id') ?? '';
    const removed = await acknowledgeTauJob(id, user);
    return removed
        ? NextResponse.json({ status: 'acknowledged' })
        : jsonError('Nie znaleziono tego wyniku.', 404);
}

async function currentUser(): Promise<string | null> {
    const session = await auth();
    return session?.user?.name?.trim() || null;
}

function jsonError(error: string, status: number) {
    return NextResponse.json({ status: 'error', error }, { status });
}
