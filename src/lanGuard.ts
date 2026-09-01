// Bramka wpuszczająca do panelu wyłącznie sieć lokalną.
//
// Sam adres nasłuchu tu nie wystarczy. Router z DMZ przekazuje ruch z
// internetu na ten sam adres LAN, na którym stoi panel, więc "nasłuchuj na
// 192.168.1.29" nie odróżnia sąsiada z internetu od komputera w domu.
// Nie wystarczy też nagłówek X-Forwarded-For: Next.js ustawia go tylko wtedy,
// gdy klient sam go nie przysłał (`??=` w base-server.js), a przysłać może
// go każdy.
//
// Dlatego pytamy o jedyną rzecz, której nie da się podrobić: adres drugiego
// końca gniazda TCP. Panel Next.js stoi wtedy na 127.0.0.1 i z zewnątrz nie
// jest osiągalny w ogóle - widać wyłącznie tę bramkę.
//
// Obcy nie dostaje żadnej odpowiedzi - ani strony, ani kodu 403, ani nawet
// pustego nagłówka. Gniazdo jest zrywane zaraz po połączeniu, więc z
// internetu port zachowuje się tak, jakby nic za nim nie stało. Wcześniejsza
// odpowiedź "tylko z sieci lokalnej" była sama w sobie informacją: potwierdzała
// skanerowi, że pod tym adresem coś działa i warto wracać.

import http from 'node:http';
import net from 'node:net';
import type { Socket } from 'node:net';

/** Zakresy uznawane za lokalne bez żadnej dodatkowej konfiguracji. */
const PRIVATE_V4 = [
    { base: '10.0.0.0', bits: 8 },
    { base: '172.16.0.0', bits: 12 },
    { base: '192.168.0.0', bits: 16 },
    { base: '127.0.0.0', bits: 8 },
    // Adres nadawany, gdy nie ma DHCP - też nie przychodzi z internetu.
    { base: '169.254.0.0', bits: 16 },
] as const;

export interface LanGuardOptions {
    /** Adres i port, na których ma stać bramka - te z PANEL_HOST/PANEL_PORT. */
    host: string;
    port: number;
    /** Gdzie faktycznie słucha Next.js. */
    targetHost: string;
    targetPort: number;
    /** Dodatkowe adresy albo zakresy CIDR spoza sieci prywatnych, np. VPN. */
    allowed?: readonly string[];
    /** Wywoływane przy odrzuconym połączeniu - do jednej linijki w konsoli. */
    onBlocked?: (address: string) => void;
}

/**
 * Czy adres jest z sieci lokalnej. Rozumie zapis IPv4, IPv6 oraz IPv4
 * opakowane w IPv6 (`::ffff:192.168.1.10`), bo w tej postaci Node podaje
 * adresy, gdy gniazdo nasłuchuje na obu rodzinach naraz.
 */
export function isLocalAddress(address: string | undefined | null): boolean {
    const value = normalizeAddress(address);
    if (!value) return false;

    if (net.isIPv4(value)) {
        return PRIVATE_V4.some((range) => inV4Range(value, range.base, range.bits));
    }

    const lower = value.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // fc00::/7 to odpowiednik sieci prywatnych, fe80::/10 - adresy łącza.
    return /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
}

/**
 * Czy adres mieści się w regule z konfiguracji. Reguła to pojedynczy adres
 * albo zakres CIDR (`100.64.0.0/10`).
 */
export function matchesRule(address: string | undefined | null, rule: string): boolean {
    const value = normalizeAddress(address);
    const clean = rule.trim();
    if (!value || clean.length === 0) return false;

    const slash = clean.indexOf('/');
    if (slash < 0) return value.toLowerCase() === normalizeAddress(clean)?.toLowerCase();

    const base = clean.slice(0, slash);
    const bits = Number.parseInt(clean.slice(slash + 1), 10);
    if (!net.isIPv4(base) || !net.isIPv4(value) || !Number.isFinite(bits)) return false;

    return inV4Range(value, base, Math.max(0, Math.min(32, bits)));
}

/** Czy tego klienta wpuszczamy do panelu. */
export function isAllowed(address: string | undefined | null, allowed: readonly string[]): boolean {
    return isLocalAddress(address) || allowed.some((rule) => matchesRule(address, rule));
}

/**
 * Stawia bramkę przed panelem. Zwraca gotowy serwer - wywołujący decyduje,
 * kiedy go zamknąć.
 */
export function createLanGuard(options: LanGuardOptions): http.Server {
    const allowed = [...(options.allowed ?? [])];

    /** Zrywa gniazdo bez słowa - obcy nie ma się czego uchwycić. */
    const reject = (socket: Socket): void => {
        options.onBlocked?.(normalizeAddress(socket.remoteAddress) ?? 'nieznany adres');
        socket.destroy();
    };

    const server = http.createServer((request, response) => {
        const address = request.socket.remoteAddress;
        if (!isAllowed(address, allowed)) {
            reject(request.socket);
            return;
        }

        const headers = { ...request.headers };
        // Nagłówek od klienta jest bezwartościowy - podmieniamy go na adres,
        // który naprawdę widzimy, żeby panel nie wnioskował z podróbki.
        headers['x-forwarded-for'] = normalizeAddress(address) ?? '';
        headers['x-forwarded-proto'] = 'http';

        const proxied = http.request(
            {
                host: options.targetHost,
                port: options.targetPort,
                method: request.method,
                path: request.url,
                headers,
            },
            (upstream) => {
                response.writeHead(upstream.statusCode ?? 502, upstream.headers);
                upstream.pipe(response);
            },
        );

        proxied.on('error', () => {
            if (response.writableEnded) return;
            if (!response.headersSent) {
                response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            response.end('Panel jeszcze nie odpowiada.\n');
        });

        // Przerwane żądanie to codzienność: ktoś zamknął kartę w trakcie
        // ładowania. Bez tych dwóch nasłuchów Node zgłosiłby nieobsłużony
        // błąd strumienia i zabrałby ze sobą cały proces razem z loggerem.
        request.on('error', () => proxied.destroy());
        response.on('error', () => proxied.destroy());
        response.on('close', () => {
            if (!response.writableEnded) proxied.destroy();
        });

        request.pipe(proxied);
    });

    // Next.js używa WebSocketów do odświeżania strony w trybie deweloperskim
    // i do części odpowiedzi strumieniowych - bez tego wisiałyby w nieskończoność.
    server.on('upgrade', (request, socket: Socket, head: Buffer) => {
        const address = socket.remoteAddress;
        if (!isAllowed(address, allowed)) {
            reject(socket);
            return;
        }

        const headers = { ...request.headers };
        headers['x-forwarded-for'] = normalizeAddress(address) ?? '';

        const proxied = http.request({
            host: options.targetHost,
            port: options.targetPort,
            method: request.method,
            path: request.url,
            headers,
        });

        proxied.on('upgrade', (upstream, upstreamSocket: Socket, upstreamHead: Buffer) => {
            upstreamSocket.on('error', () => socket.destroy());
            const lines = Object.entries(upstream.headers).flatMap(([key, value]) =>
                Array.isArray(value) ? value.map((item) => `${key}: ${item}`) : [`${key}: ${String(value)}`],
            );
            socket.write(
                `HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`,
            );
            if (upstreamHead.length > 0) socket.write(upstreamHead);
            upstreamSocket.pipe(socket).pipe(upstreamSocket);
        });

        proxied.on('error', () => socket.destroy());
        socket.on('error', () => proxied.destroy());
        if (head.length > 0) proxied.write(head);
        proxied.end();
    });

    // Pierwsza i najtwardsza kontrola: zanim jeszcze przeczytamy jedną linię
    // żądania. Obcy dostaje wyłącznie zamknięte gniazdo, więc przeglądarka
    // pokazuje błąd połączenia zamiast strony z komunikatem. Kontrole wyżej
    // zostają drugą siatką - i one też nigdy nie odpowiadają treścią.
    server.on('connection', (socket: Socket) => {
        if (!isAllowed(socket.remoteAddress, allowed)) reject(socket);
    });

    server.listen(options.port, options.host);
    return server;
}

/** Wolny port na pętli zwrotnej - tam chowamy sam panel. */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, host, () => {
            const address = probe.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            probe.close(() => {
                if (port > 0) resolve(port);
                else reject(new Error('nie udało się znaleźć wolnego portu'));
            });
        });
    });
}

/** `::ffff:192.168.1.10` → `192.168.1.10`; puste wejście → null. */
function normalizeAddress(address: string | undefined | null): string | null {
    const value = String(address ?? '').trim();
    if (value.length === 0) return null;

    // Adres łącza bywa podawany z nazwą interfejsu: fe80::1%eth0.
    const withoutZone = value.split('%')[0] ?? value;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(withoutZone);
    return mapped?.[1] ?? withoutZone;
}

function inV4Range(address: string, base: string, bits: number): boolean {
    if (bits === 0) return true;
    const value = toV4Number(address);
    const start = toV4Number(base);
    if (value === null || start === null) return false;

    // Przesunięcie o 32 jest w JavaScripcie tożsamościowe, stąd osobny mnożnik.
    const mask = bits >= 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
    return (value & mask) >>> 0 === (start & mask) >>> 0;
}

function toV4Number(address: string): number | null {
    if (!net.isIPv4(address)) return null;
    return address
        .split('.')
        .reduce((total, part) => ((total << 8) | Number.parseInt(part, 10)) >>> 0, 0);
}
