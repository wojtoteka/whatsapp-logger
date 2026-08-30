// Kolejka panelu do usługi ?tau w procesie loggera. Zadanie zawiera tylko
// nazwę folderu i pytanie; kontekst rozmowy nigdy nie trafia do tego pliku.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logsDir } from './archiwum';

interface TauJobRequest {
    id: string;
    folder: string;
    question: string;
    requestedBy: string;
    createdAt: string;
}

interface TauJobResult {
    id: string;
    requestedBy: string;
    status: 'done' | 'error';
    answer?: string;
    error?: string;
    completedAt: string;
}

export type TauJobStatus =
    | { status: 'pending' }
    | { status: 'done'; answer: string }
    | { status: 'error'; error: string };

export function tauEnabled(): boolean {
    return ['true', '1', 'tak', 'yes', 'on'].includes(
        (process.env.TAU_ENABLED ?? '').trim().toLowerCase(),
    );
}

export async function createTauJob(
    folder: string,
    question: string,
    requestedBy: string,
): Promise<string> {
    const root = queueRoot();
    const requests = path.join(root, 'requests');
    const processing = path.join(root, 'processing');
    const results = path.join(root, 'results');
    await Promise.all([
        fs.mkdir(requests, { recursive: true }),
        fs.mkdir(processing, { recursive: true }),
        fs.mkdir(results, { recursive: true }),
    ]);
    await pruneOldResults(results);

    const pending = await countOwnedJobs([requests, processing], requestedBy);
    if (pending >= 3) throw new Error('Masz już trzy oczekujące zapytania ?tau. Poczekaj na odpowiedzi.');

    const id = randomUUID();
    const job: TauJobRequest = {
        id,
        folder,
        question,
        requestedBy,
        createdAt: new Date().toISOString(),
    };
    const temporary = path.join(requests, `.${id}.tmp`);
    const target = path.join(requests, `${id}.json`);
    await fs.writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    });
    await fs.rename(temporary, target);
    return id;
}

export async function readTauJob(id: string, requestedBy: string): Promise<TauJobStatus | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const root = queueRoot();
    const resultFile = path.join(root, 'results', `${id}.json`);
    const result = await readJson<TauJobResult>(resultFile);
    if (result) {
        if (result.requestedBy !== requestedBy || result.id !== id) return null;
        if (result.status === 'done') {
            return { status: 'done', answer: result.answer?.trim() || 'Provider zwrócił pustą odpowiedź.' };
        }
        return { status: 'error', error: result.error?.trim() || 'Zapytanie ?tau nie powiodło się.' };
    }

    for (const directory of ['requests', 'processing']) {
        const job = await readJson<TauJobRequest>(path.join(root, directory, `${id}.json`));
        if (job) return job.requestedBy === requestedBy ? { status: 'pending' } : null;
    }

    // Logger mógł przenieść plik z processing do results dokładnie między
    // dwoma odczytami powyżej. Powtórka zamyka to małe okno wyścigu.
    const racedResult = await readJson<TauJobResult>(resultFile);
    if (racedResult?.requestedBy === requestedBy && racedResult.id === id) {
        return racedResult.status === 'done'
            ? { status: 'done', answer: racedResult.answer?.trim() || 'Provider zwrócił pustą odpowiedź.' }
            : { status: 'error', error: racedResult.error?.trim() || 'Zapytanie ?tau nie powiodło się.' };
    }
    return null;
}

/** Kasuje wyłącznie odebrany wynik należący do bieżącego użytkownika. */
export async function acknowledgeTauJob(id: string, requestedBy: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const file = path.join(queueRoot(), 'results', `${id}.json`);
    const result = await readJson<TauJobResult>(file);
    if (!result || result.id !== id || result.requestedBy !== requestedBy) return false;
    await fs.rm(file, { force: true });
    return true;
}

function queueRoot(): string {
    return path.join(logsDir(), '_tau');
}

async function countOwnedJobs(directories: readonly string[], requestedBy: string): Promise<number> {
    let count = 0;
    for (const directory of directories) {
        let files: string[];
        try {
            files = await fs.readdir(directory);
        } catch {
            continue;
        }
        for (const file of files) {
            if (!/^[0-9a-f-]{36}\.json$/i.test(file)) continue;
            const job = await readJson<TauJobRequest>(path.join(directory, file));
            if (job?.requestedBy === requestedBy) count++;
        }
    }
    return count;
}

async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

async function pruneOldResults(directory: string): Promise<void> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let files: string[];
    try {
        files = await fs.readdir(directory);
    } catch {
        return;
    }
    await Promise.all(
        files
            .filter((file) => /^[0-9a-f-]{36}\.json$/i.test(file))
            .map(async (file) => {
                const full = path.join(directory, file);
                try {
                    if ((await fs.stat(full)).mtimeMs < cutoff) await fs.rm(full, { force: true });
                } catch {
                    // Równoległy odczyt mógł już skasować ten krótkotrwały wynik.
                }
            }),
    );
}
