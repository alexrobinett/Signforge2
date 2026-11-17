// The nudge socket (M3-06): the player keeps one socket to the API, syncs the moment it is told
// of a new manifest, acts on commands at once, and polls only while the socket is down.
import { expect, it } from 'vitest';
import type { FixtureServer } from './fixture-server';
import { useHarness } from './harness';

const h = useHarness();

/** Content on another origin, as the API is: the player opens its socket there. */
const remote = (poll: string) => (server: FixtureServer) => ({ content: `${server.localUrl}/content`, poll });

it('syncs at once when the socket says a new manifest is published, and reports it applied', async () => {
  const first = h.content([{ id: 'a', durationMs: 800, label: 'first' }]);
  // A poll every minute: only the socket can bring the second manifest within the test.
  const p = await h.openPlayer((server) => server.publish(first), remote('60'));
  await p.until((s) => s.manifestId === first.manifest.id && s.socket);
  await expect.poll(() => p.server.socketMessages).toContainEqual({ type: 'applied', manifest: first.manifest.id });

  const second = h.content([{ id: 'b', durationMs: 800, label: 'second' }]);
  p.server.publish(second);
  const pushed = Date.now();
  p.server.push({ type: 'manifest', id: second.manifest.id });
  await p.until((s) => s.log.some((l) => l.manifest === second.manifest.id), 5000);
  expect(Date.now() - pushed).toBeLessThan(5000);
  await expect.poll(() => p.server.socketMessages).toContainEqual({ type: 'applied', manifest: second.manifest.id });
});

it('does not sync between nudges while the socket is up, and syncs every poll when it drops', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await h.openPlayer((server) => server.publish(content), remote('1'));
  await p.until((s) => s.manifestId === content.manifest.id && s.socket);
  // With the API every look is a sync (M3-07); the manifest is fetched only when the sync names a new one.
  const polls = () => p.server.syncs.length;
  const before = polls();
  await new Promise((r) => setTimeout(r, 2500));
  expect(polls() - before).toBeLessThanOrEqual(1);

  // Refuse new sockets and drop the open one: the player falls back to polling every second.
  const refuse = p.server.intercept(/^\/content\/ws$/, { status: 503 });
  p.server.dropSockets();
  await p.until((s) => !s.socket);
  const down = polls();
  await expect.poll(polls, { timeout: 5000 }).toBeGreaterThanOrEqual(down + 2);

  // And reconnects once it can.
  refuse();
  const opened = p.server.socketsOpened;
  await p.until((s) => s.socket, 15_000);
  expect(p.server.socketsOpened).toBeGreaterThan(opened);
});

it('acts on a display override at once, not at the next display-hours check', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await h.openPlayer((server) => server.publish(content), remote('60'));
  await p.until((s) => s.played > 0 && s.socket && s.displayOn);
  const until = new Date(Date.now() + 3_600_000).toISOString();
  p.server.push({ type: 'command', command: { type: 'display', override: { state: 'off', until } } });
  await p.until((s) => !s.displayOn, 3000);

  // Cleared: back to display hours (none, so on).
  p.server.push({ type: 'command', command: { type: 'display', override: null } });
  await p.until((s) => s.displayOn, 12_000);
});

// `revoked` on the socket: browser/pairing.test.ts (the screen wipes itself and shows a code).
