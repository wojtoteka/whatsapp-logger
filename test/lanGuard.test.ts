import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLanGuard, findFreePort, isAllowed, isLocalAddress, matchesRule } from '../src/lanGuard';

test('adresy z sieci lokalnej są rozpoznawane, publiczne nie', () => {
    for (const address of [
        '127.0.0.1',
        '192.168.1.29',
        '10.0.0.5',
        '172.16.0.1',
        '172.31.255.254',
        '169.254.10.1',
        '::1',
        'fd00::1',
        'fe80::1%eth0',
        // Tak Node podaje adres IPv4, gdy gniazdo słucha na obu rodzinach.
        '::ffff:192.168.1.29',
    ]) {
        assert.equal(isLocalAddress(address), true, `${address} powinien być lokalny`);
    }

    for (const address of [
        '8.8.8.8',
        '1.1.1.1',
        // Granice zakresów prywatnych - o jeden krok za daleko.
        '172.15.255.255',
        '172.32.0.1',
        '192.169.0.1',
        '11.0.0.1',
        '2001:4860:4860::8888',
        '::ffff:8.8.8.8',
        '',
        null,
        undefined,
    ]) {
        assert.equal(isLocalAddress(address), false, `${String(address)} nie jest lokalny`);
    }
});

test('lista dodatkowych adresów rozumie pojedynczy adres i zakres CIDR', () => {
    assert.equal(matchesRule('100.101.102.103', '100.64.0.0/10'), true);
    assert.equal(matchesRule('100.128.0.1', '100.64.0.0/10'), false);
    assert.equal(matchesRule('203.0.113.7', '203.0.113.7'), true);
    assert.equal(matchesRule('203.0.113.8', '203.0.113.7'), false);
    assert.equal(matchesRule('::ffff:203.0.113.7', '203.0.113.7'), true);
    assert.equal(matchesRule('203.0.113.7', 'to nie jest adres'), false);

    assert.equal(isAllowed('8.8.8.8', []), false);
    assert.equal(isAllowed('8.8.8.8', ['8.8.8.8']), true);
    assert.equal(isAllowed('192.168.0.2', []), true);
});

test('bramka przepuszcza połączenie z pętli zwrotnej i podmienia X-Forwarded-For', async () => {
    let seenForwardedFor: string | undefined;

    const panel = http.createServer((request, response) => {
        seenForwardedFor = request.headers['x-forwarded-for'] as string | undefined;
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('archiwum');
    });
    await listen(panel);

    const guard = createLanGuard({
        host: '127.0.0.1',
        port: await findFreePort(),
        targetHost: '127.0.0.1',
        targetPort: (panel.address() as AddressInfo).port,
    });
    await once(guard, 'listening');

    try {
        const port = (guard.address() as AddressInfo).port;
        const answer = await get(port, {
            // Klient z internetu podszywa się pod adres z sieci domowej -
            // bramka patrzy na gniazdo, więc nagłówek nie ma tu nic do rzeczy.
            'x-forwarded-for': '192.168.1.29',
        });

        assert.equal(answer.status, 200);
        assert.equal(answer.body, 'archiwum');
        assert.equal(seenForwardedFor, '127.0.0.1', 'panel widzi prawdziwy adres, nie podrobiony');
    } finally {
        await close(guard);
        await close(panel);
    }
});

test('bramka nie dopuszcza do panelu, gdy adres nie przechodzi kontroli', async () => {
    let panelCalls = 0;
    const panel = http.createServer((_request, response) => {
        panelCalls++;
        response.end('nie powinno tu dojść');
    });
    await listen(panel);

    const blocked: string[] = [];
    const guard = createLanGuard({
        host: '127.0.0.1',
        port: await findFreePort(),
        targetHost: '127.0.0.1',
        targetPort: (panel.address() as AddressInfo).port,
        // Testy chodzą po pętli zwrotnej, więc do odtworzenia odmowy trzeba
        // podmienić samą regułę - inaczej 127.0.0.1 zawsze przechodzi.
        allowed: [],
        onBlocked: (address) => blocked.push(address),
    });
    await once(guard, 'listening');

    // Podmieniamy widok gniazda na adres z internetu.
    guard.on('connection', (socket) => {
        Object.defineProperty(socket, 'remoteAddress', { value: '8.8.8.8', configurable: true });
    });

    try {
        const port = (guard.address() as AddressInfo).port;
        const answer = await get(port);

        assert.equal(answer.status, 403);
        assert.match(answer.body, /sieci lokalnej/);
        assert.equal(panelCalls, 0, 'panel nie dostał tego żądania w ogóle');
        assert.deepEqual(blocked, ['8.8.8.8']);
    } finally {
        await close(guard);
        await close(panel);
    }
});

// ── Drobiazgi ────────────────────────────────────────────────────────────

function listen(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

function once(server: http.Server, event: string): Promise<void> {
    return new Promise((resolve) => {
        if (server.listening) {
            resolve();
            return;
        }
        server.once(event, () => resolve());
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function get(
    port: number,
    headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, path: '/', headers }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        });
        request.on('error', reject);
    });
}
