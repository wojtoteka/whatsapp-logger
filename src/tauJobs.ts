// Most między panelem (osobny proces Next.js) a jedyną usługą ?tau działającą
// przy kliencie WhatsApp. Pliki zadań nie zawierają kontekstu rozmowy.

import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './log';
import { ensureDir, listDirents, readJson, writeJsonAtomic } from './util';

export interface TauJobRequest {
    id: string;
    folder: string;
    question: string;
    requestedBy: string;
    createdAt: string;
}

export interface TauJobResult {
    id: string;
    requestedBy: string;
    status: 'done' | 'error';
    answer?: string;
    error?: string;
    completedAt: string;
}

export class TauJobWorker {
    private timer: NodeJS.Timeout | null = null;
    private current: Promise<void> | null = null;
    private stopped = false;

    constructor(
        private readonly logsDir: string,
        private readonly ask: (folder: string, question: string) => Promise<string>,
    ) {}

    async start(): Promise<void> {
        this.stopped = false;
        await Promise.all([
            ensureDir(this.requestsDir),
            ensureDir(this.processingDir),
            ensureDir(this.resultsDir),
        ]);
        await this.recoverInterrupted();
        void this.tick();
        this.timer = setInterval(() => void this.tick(), 750);
        this.timer.unref?.();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.current?.catch(() => undefined);
    }

    private async tick(): Promise<void> {
        if (this.stopped || this.current) return;
        const task = this.processNext();
        this.current = task;
        try {
            await task;
        } catch (error) {
            // Kolejka AI jest dodatkiem. Nawet błąd dysku w _tau nie może
            // wejść jako nieobsłużone odrzucenie i zrestartować loggera.
            log.error('Błąd kolejki panelu ?tau', error, { stage: 'tau job worker' });
        } finally {
            if (this.current === task) this.current = null;
        }
    }

    private async processNext(): Promise<void> {
        const file = (await listDirents(this.requestsDir))
            .filter((entry) => entry.isFile() && isJobFile(entry.name))
            .map((entry) => entry.name)
            .sort()[0];
        if (!file) return;

        const source = path.join(this.requestsDir, file);
        const claimed = path.join(this.processingDir, file);
        try {
            await fs.rename(source, claimed);
        } catch {
            return;
        }

        const job = await readJson<TauJobRequest>(claimed);
        if (!validJob(job, file)) {
            await fs.rm(claimed, { force: true });
            return;
        }

        let result: TauJobResult;
        try {
            const answer = await this.ask(job.folder, job.question);
            result = {
                id: job.id,
                requestedBy: job.requestedBy,
                status: 'done',
                answer,
                completedAt: new Date().toISOString(),
            };
        } catch (error) {
            result = {
                id: job.id,
                requestedBy: job.requestedBy,
                status: 'error',
                error: safeError(error),
                completedAt: new Date().toISOString(),
            };
        }

        await writeJsonAtomic(path.join(this.resultsDir, file), result);
        await fs.rm(claimed, { force: true });
    }

    /**
     * Po restarcie nie ponawiamy requestu, który mógł już wyjść do providera.
     * Panel dostaje jawny błąd zamiast ryzyka podwójnego wysłania kontekstu.
     */
    private async recoverInterrupted(): Promise<void> {
        for (const entry of await listDirents(this.processingDir)) {
            if (!entry.isFile() || !isJobFile(entry.name)) continue;
            const file = path.join(this.processingDir, entry.name);
            const job = await readJson<TauJobRequest>(file);
            if (job && validJob(job, entry.name)) {
                await writeJsonAtomic(path.join(this.resultsDir, entry.name), {
                    id: job.id,
                    requestedBy: job.requestedBy,
                    status: 'error',
                    error: 'Logger uruchomił się ponownie podczas zapytania. Zadaj je jeszcze raz.',
                    completedAt: new Date().toISOString(),
                } satisfies TauJobResult);
            }
            await fs.rm(file, { force: true });
        }
    }

    private get root(): string {
        return path.join(this.logsDir, '_tau');
    }

    private get requestsDir(): string {
        return path.join(this.root, 'requests');
    }

    private get processingDir(): string {
        return path.join(this.root, 'processing');
    }

    private get resultsDir(): string {
        return path.join(this.root, 'results');
    }
}

function isJobFile(file: string): boolean {
    return /^[0-9a-f-]{36}\.json$/i.test(file);
}

function validJob(job: TauJobRequest | null, file: string): job is TauJobRequest {
    return Boolean(
        job &&
            `${job.id}.json` === file &&
            typeof job.folder === 'string' &&
            job.folder.length > 0 &&
            typeof job.question === 'string' &&
            job.question.length > 0 &&
            job.question.length <= 4000 &&
            typeof job.requestedBy === 'string' &&
            job.requestedBy.length > 0,
    );
}

function safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 500) || 'Błąd ?tau.';
}
