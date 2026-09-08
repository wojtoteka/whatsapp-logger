'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { plural } from '@/lib/format';
import { znajdz } from '@/lib/szukaj';
import type { Trafienie } from '@/lib/szukaj';
import { Awatar } from './Awatar';
import { MaterialIcon } from './MaterialIcon';

/**
 * Czat gotowy do pokazania.
 *
 * Daty i odmiany są tu już gotowymi napisami, policzonymi na serwerze.
 * Liczenie ich tutaj oznaczałoby robienie tego dwa razy - raz przy renderze
 * po stronie serwera, raz przy uruchomieniu w przeglądarce - a że "wczoraj"
 * i godzina zależą od strefy czasowej, oba wyniki nie musiałyby się zgadzać.
 */
export interface KartaCzatu {
    folder: string;
    slug: string;
    name: string;
    avatar: string | null;
    preview: string | null;
    /** "wczoraj", "3 dni temu", godzina. */
    when: string;
    /** "12 wiadomości". */
    meta: string;
}

export interface TekstySzukania {
    /** Napis w pustym polu. */
    placeholder: string;
    /** Odmiana do licznika wyników: 1 czat, 2 czaty, 5 czatów. */
    noun: [one: string, few: string, many: string];
}

interface Props {
    chats: KartaCzatu[];
    search: TekstySzukania;
}

/** Pola, w których ukośnik jest zwykłym znakiem, a nie skrótem klawiszowym. */
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function SzukajkaCzatow({ chats, search }: Props) {
    const [query, setQuery] = useState('');
    const input = useRef<HTMLInputElement>(null);
    const fieldId = useId();

    const szukane = query.trim();

    // Jedno pytanie odpowiada i za filtr, i za podświetlenie - dzięki temu
    // podświetla się dokładnie to, co zdecydowało o pozostaniu na liście.
    const found = useMemo(() => {
        const rows: { chat: KartaCzatu; hit: Trafienie }[] = [];
        for (const chat of chats) {
            const hit = znajdz(chat.name, query);
            if (hit) rows.push({ chat, hit });
        }
        return rows;
    }, [chats, query]);

    // Ukośnik ustawia kursor w polu - tak samo jak w GitHubie czy Gmailu.
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;

            const active = document.activeElement;
            const writing =
                active instanceof HTMLElement &&
                (active.isContentEditable || TYPING.has(active.tagName));
            if (writing) return;

            event.preventDefault();
            input.current?.focus();
        };

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const wyczysc = (): void => {
        setQuery('');
        input.current?.focus();
    };

    return (
        <>
            <div className="search">
                <div className="search-field">
                    <MaterialIcon name="search" className="search-icon" />

                    <label className="sr-only" htmlFor={fieldId}>
                        {search.placeholder}
                    </label>
                    <input
                        id={fieldId}
                        ref={input}
                        className="search-input"
                        type="search"
                        value={query}
                        placeholder={search.placeholder}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== 'Escape') return;
                            // Pierwszy Escape czyści, drugi oddaje klawiaturę stronie.
                            if (query) {
                                event.preventDefault();
                                setQuery('');
                            } else {
                                input.current?.blur();
                            }
                        }}
                    />

                    {query ? (
                        <button type="button" className="search-clear" onClick={wyczysc}>
                            <MaterialIcon name="close" label="Wyczyść wyszukiwanie" />
                        </button>
                    ) : (
                        <kbd className="search-hint" aria-hidden="true">
                            /
                        </kbd>
                    )}
                </div>

                {/* Element istnieje zawsze, żeby czytnik ekranu miał co śledzić. */}
                <p className="search-count" role="status" aria-live="polite">
                    {szukane
                        ? `${found.length} ${plural(found.length, ...search.noun)} z ${chats.length}`
                        : ''}
                </p>
            </div>

            {found.length === 0 ? (
                <div className="empty-state">
                    <h2>Nic nie pasuje</h2>
                    <div>
                        Żadna nazwa nie zawiera <strong>{szukane}</strong>.
                        <br />
                        <button type="button" className="link-button" onClick={wyczysc}>
                            Wyczyść wyszukiwanie
                        </button>
                    </div>
                </div>
            ) : (
                <div className="chat-grid">
                    {found.map(({ chat, hit }) => (
                        <Link key={chat.folder} className="chat-card" href={`/czat/${chat.slug}`}>
                            <Awatar path={chat.avatar} name={chat.name} size="md" />

                            <div className="body">
                                <div className="row">
                                    <span className="name">
                                        {hit.before}
                                        {hit.match ? <mark className="hit">{hit.match}</mark> : null}
                                        {hit.after}
                                    </span>
                                    <span className="when">{chat.when}</span>
                                </div>
                                {chat.preview && <div className="preview">{chat.preview}</div>}
                                <div className="meta">{chat.meta}</div>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
        </>
    );
}
