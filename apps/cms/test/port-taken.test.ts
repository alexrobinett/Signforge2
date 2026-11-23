// The e2e refuses ports something already holds (`portTaken` in e2e/servers.ts), or its tests talk to
// that process instead. The CMS is reached at `localhost`, which may resolve to ::1: a server there
// alone (as `vite preview` binds) must count, as must one that does not speak HTTP (#214's run).
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { portTaken } from '../e2e/servers';

const servers: Server[] = [];
async function hold(host: string, port = 0): Promise<number> {
  const server = createServer((socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('not listening');
  return address.port;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('portTaken', () => {
  it('counts a port held on 127.0.0.1', async () => {
    expect(await portTaken(await hold('127.0.0.1'))).toBe(true);
  });
  it('counts a port held on ::1 alone', async () => {
    expect(await portTaken(await hold('::1'))).toBe(true);
  });
  it('leaves a free port free', async () => {
    const port = await hold('127.0.0.1');
    await new Promise((resolve) => servers.splice(0)[0]?.close(resolve));
    expect(await portTaken(port)).toBe(false);
  });
});
