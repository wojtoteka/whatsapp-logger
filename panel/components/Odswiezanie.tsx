'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Odświeża wyłącznie dane bieżącej strony. Serwer ponownie czyta ostatnią
 * paczkę, nie całe archiwum, więc nowe wiadomości dochodzą bez ręcznego F5.
 */
export function Odswiezanie({ enabled }: { enabled: boolean }) {
    const router = useRouter();

    useEffect(() => {
        if (!enabled) return;
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') router.refresh();
        }, 15_000);
        return () => window.clearInterval(timer);
    }, [enabled, router]);

    return null;
}
