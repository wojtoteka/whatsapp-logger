// Adresy plików z archiwum.
//
// Osobny moduł od archiwum.ts, bo tamten sięga do dysku przez node:fs,
// a te dwie linijki muszą działać też po stronie przeglądarki - używa ich
// awatar na liście czatów, a ta lista filtruje się już u klienta.

/** Adres, spod którego panel serwuje plik z archiwum. */
export function fileUrl(archivePath: string | null): string | null {
    if (!archivePath) return null;
    const parts = archivePath.split('/').filter(Boolean).map(encodeURIComponent);
    return `/api/plik/${parts.join('/')}`;
}
