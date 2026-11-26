// A CMS tab names the org it shows (#129). After the member switches org in another tab, a call
// from the tab still showing the old org is refused, never run in the session's new org.
import { env } from 'cloudflare:workers';
import { testScope } from '@signforge/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { TAB_ORG_HEADER } from '../src/api/tab-org';
import { Client, email, testApp } from './client';

const t = testApp();
const alice = new Client(t);
const bob = new Client(t);
let north: string;
let south: string;
let bobs: string;
let screen: string;

const from = (orgId: string) => ({ [TAB_ORG_HEADER]: orgId });
const switched = { error: 'org_changed', message: 'This tab is on Northside; you switched to Southside in another tab. Reload.' };

beforeAll(async () => {
  await alice.signIn(email('alice'));
  await bob.signIn(email('bob'));
  north = (await alice.createOrg('Northside')).id;
  screen = (await testScope(env.DB, north).screens.insert({ name: 'Lobby', timezone: 'UTC', orientation: 'landscape' })).id;
  south = (await alice.createOrg('Southside')).id;
  bobs = (await bob.createOrg('Bob Co')).id;
  // Another tab switched to Southside: this session's active org.
  expect((await alice.setActive(south)).status).toBe(200);
});

describe("a tab on the session's old org", () => {
  it('is refused a write, which changes nothing', async () => {
    const res = await alice.tool('update_screen', { screenId: screen, name: 'Moved' }, from(north));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(switched);
    expect(await testScope(env.DB, north).screens.get(screen)).toMatchObject({ name: 'Lobby' });
  });

  it("is refused a read, such as the audit log an export pages through, rather than given the new org's", async () => {
    const res = await alice.tool('list_audit_log', { limit: 200 }, from(north));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(switched);
  });

  it('is refused the session, so its shell never quietly becomes the new org', async () => {
    const res = await alice.get('/api/session', from(north));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(switched);
  });

  it("is refused Better Auth's org calls, which act on the active org, but may switch org", async () => {
    const invite = await alice.post('/api/auth/organization/invite-member', { email: email('carol'), role: 'viewer' }, from(north));
    expect(invite.status).toBe(409);
    expect(await invite.json()).toEqual(switched);
    const members = await alice.get('/api/auth/organization/list-members', from(north));
    expect(members.status).toBe(409);

    // The tab's own switch names the org it showed until then.
    expect((await alice.post('/api/auth/organization/set-active', { organizationId: north }, from(south))).status).toBe(200);
    expect((await alice.tool('get_screen', { screenId: screen }, from(north))).status).toBe(200);
    expect((await alice.post('/api/auth/organization/set-active', { organizationId: south }, from(north))).status).toBe(200);
  });
});

describe('a call without a tab', () => {
  it("acts in the session's active org, as agents, scripts and the CLI do", async () => {
    const res = await alice.tool('list_screens');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { screens: unknown[] }).screens).toEqual([]);
  });
});

describe('a tab on the active org', () => {
  it('acts as before', async () => {
    expect((await alice.tool('list_screens', {}, from(south))).status).toBe(200);
    expect((await alice.get('/api/session', from(south))).status).toBe(200);
  });
});

describe('the refusal', () => {
  it("names only orgs the member belongs to: a header can neither pick an org nor learn another's name", async () => {
    const res = await alice.tool('list_screens', {}, from(bobs));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'org_changed',
      message: 'This tab is on another organization; you switched to Southside in another tab. Reload.',
    });
  });

  it('is the same for an empty header, on the tools, the session and Better Auth alike', async () => {
    const empty = { error: 'org_changed', message: 'This tab is on another organization; you switched to Southside in another tab. Reload.' };
    for (const res of [
      await alice.tool('list_screens', {}, from('')),
      await alice.get('/api/session', from('')),
      await alice.get('/api/auth/organization/list-members', from('')),
    ]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(empty);
    }
  });

  it('says so when the session has no active org any more', async () => {
    const carol = new Client(t);
    await carol.signIn(email('carol'));
    const res = await carol.get('/api/session', from(north));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'org_changed',
      message: 'This tab is on another organization, which is no longer your active organization. Reload.',
    });
  });
});
