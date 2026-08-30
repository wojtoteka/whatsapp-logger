'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type Phase = 'idle' | 'sending' | 'waiting' | 'done' | 'error';

interface ApiResponse {
    id?: string;
    status?: 'pending' | 'done' | 'error';
    answer?: string;
    error?: string;
}

export function TauPanel({ folder, enabled }: { folder: string; enabled: boolean }) {
    const [question, setQuestion] = useState('');
    const [phase, setPhase] = useState<Phase>('idle');
    const [answer, setAnswer] = useState('');
    const [error, setError] = useState('');
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => () => abortRef.current?.abort(), []);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const clean = question.trim();
        if (!clean || phase === 'sending' || phase === 'waiting') return;

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setPhase('sending');
        setAnswer('');
        setError('');

        try {
            const response = await fetch('/api/tau', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder, question: clean }),
                signal: controller.signal,
            });
            const data = (await response.json()) as ApiResponse;
            if (!response.ok || !data.id) throw new Error(data.error || 'Nie udało się wysłać zapytania.');
            setPhase('waiting');
            await poll(data.id, controller);
        } catch (caught) {
            if (controller.signal.aborted) return;
            setError(caught instanceof Error ? caught.message : 'Nie udało się wysłać zapytania.');
            setPhase('error');
        }
    }

    async function poll(id: string, controller: AbortController) {
        // Trzy zadania mogą czekać w kolejce, a każde ma konfigurowalny
        // timeout do 10 minut. UI nie porzuca ostatniego z nich przedwcześnie.
        const deadline = Date.now() + 31 * 60 * 1000;
        while (!controller.signal.aborted && Date.now() < deadline) {
            await wait(1000, controller.signal);
            const response = await fetch(`/api/tau?id=${encodeURIComponent(id)}`, {
                cache: 'no-store',
                signal: controller.signal,
            });
            const data = (await response.json()) as ApiResponse;
            if (!response.ok) throw new Error(data.error || 'Nie udało się odczytać odpowiedzi.');
            if (data.status === 'pending') continue;
            if (data.status === 'done') {
                setAnswer(data.answer || 'Provider zwrócił pustą odpowiedź.');
                setPhase('done');
                void acknowledge(id);
                return;
            }
            void acknowledge(id);
            throw new Error(data.error || 'Zapytanie ?tau nie powiodło się.');
        }
        if (!controller.signal.aborted) throw new Error('Minął czas oczekiwania na odpowiedź.');
    }

    if (!enabled) {
        return (
            <section className="tau-card disabled" aria-label="Asystent tau">
                <strong>?tau</strong>
                <span>Asystent jest wyłączony. Ustaw TAU_ENABLED=true w głównym pliku .env.</span>
            </section>
        );
    }

    const busy = phase === 'sending' || phase === 'waiting';
    return (
        <section className="tau-card" aria-label="Asystent tau">
            <div className="tau-title">
                <strong>?tau</strong>
                <span>Prywatne pytanie o ostatnie 200 wiadomości tekstowych</span>
            </div>
            <form onSubmit={submit}>
                <textarea
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="O czym jest ostatni kontekst tej rozmowy?"
                    maxLength={4000}
                    rows={3}
                    disabled={busy}
                    aria-label="Pytanie do tau"
                />
                <button type="submit" disabled={busy || !question.trim()}>
                    {phase === 'sending' ? 'Wysyłanie...' : phase === 'waiting' ? 'Oczekiwanie...' : 'Zapytaj'}
                </button>
            </form>
            {phase === 'waiting' && <p className="tau-status">Provider analizuje rozmowę.</p>}
            {phase === 'done' && <div className="tau-answer">{answer}</div>}
            {phase === 'error' && <div className="tau-error">{error}</div>}
        </section>
    );
}

async function acknowledge(id: string): Promise<void> {
    try {
        await fetch(`/api/tau?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
        // Stary wynik usunie automatyczne sprzątanie po 24 godzinach.
    }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException('Przerwano', 'AbortError'));
        };
        const timer = window.setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
