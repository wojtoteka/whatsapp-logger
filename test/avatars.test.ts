import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AvatarStore } from '../src/avatars';
import type { WaContact } from '../src/types';
import { fakeClient, fakeMessage, testConfig, withTempDir } from './helpers';

test('awatar jest pobierany, zapisywany i zwracany jako ścieżka czatu', async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const server = http.createServer((_request, response) => {
        response.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': String(image.length),
        });
        response.end(image);
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    try {
        const address = server.address() as AddressInfo;
        const avatarUrl = `http://127.0.0.1:${address.port}/avatar.jpg`;

        await withTempDir(async (dir) => {
            const id = '48123123123@c.us';
            const contact = { id: { _serialized: id }, number: '48123123123' } as WaContact;
            const client = fakeClient({ profilePics: { [id]: avatarUrl } });
            const config = testConfig(dir, { saveProfilePics: true });
            const chatDir = path.join(dir, 'Albert');
            const store = new AvatarStore(config, client);

            const relative = await store.pathFor(
                contact,
                fakeMessage({ from: id, contact }),
                chatDir,
            );

            assert.ok(relative, 'powinna powstać ścieżka do awatara');
            assert.match(relative, /^\.\.\/_avatars\/48123123123_c\.us\//);
            const saved = await fs.readFile(path.resolve(chatDir, relative));
            assert.deepEqual(saved, image);

            const history = JSON.parse(
                await fs.readFile(path.join(dir, '_avatars', '_historia.json'), 'utf8'),
            ) as Record<string, { versions: unknown[] }>;
            assert.equal(history[id]?.versions.length, 1);
        });
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
});
