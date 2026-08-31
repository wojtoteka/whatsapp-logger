// Normalizacja argumentów launchera. npm 11 na Windowsie zamienia flagi
// --nazwa na zmienne npm_config_nazwa, więc odtwarzamy je jawnie.

export const CLI_FLAGS = [
    '--sprawdz',
    '--check',
    '--sprawdz-archiwum',
    '--sprawdz-media',
    '--nadrob-wszystko',
    '--backfill-all',
    '--uzytkownik',
    '--user',
    '--baza',
    '--db',
] as const;

export type CliFlag = (typeof CLI_FLAGS)[number];

export function normalizeCliArgs(
    directArgs: readonly string[],
    env: Record<string, string | undefined>,
): string[] {
    const npmFlags = CLI_FLAGS.filter((flag) => {
        if (directArgs.includes(flag)) return false;
        const key = `npm_config_${flag.slice(2).replace(/-/g, '_')}`;
        return ['true', '1'].includes(String(env[key] ?? '').toLowerCase());
    });
    return [...npmFlags, ...directArgs];
}

export function isOneShot(args: readonly string[]): boolean {
    return args.some((arg) => CLI_FLAGS.includes(arg as CliFlag));
}
