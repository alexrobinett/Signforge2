// Agent drafts in the editors (M4-11, #116): an agent's edit of a spot or playlist keeps the draft it
// replaced, so a person's edit is never lost to it. Reject puts the person's draft back (its sample
// text marks too) and keeps the agent's beside it; the same call again is its Undo. Keep, a person's
// edit and a publish end the proposal; deleting the draft takes it along. Every write is held to the
// version shown, and an agent's write to the version it read.
import { published } from '@signforge/db';
import { seedOrg, testScope, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Caller, CMS_AGENT_CLIENT_ID, dispatch, registry, type Role } from '../src';
import { call, racing, unlimited } from './calls';
import { fakeServices } from './services';

let orgs = 0;
let o: SeededOrg;
beforeEach(async () => {
  o = await seedOrg(env.DB, `agent-drafts-${++orgs}`);
});

const scope = () => testScope(env.DB, o.orgId);
const person = (role: Role = 'editor', clientId = 'cms'): Caller => ({
  org: scope(),
  role,
  actor: { kind: 'user', id: `${o.orgId}-${role}`, clientId },
  blobs: env.BLOBS,
  services: fakeServices,
});
/** The seeded agent grant over /mcp, drafting only. */
const agent = (): Caller => ({
  ...person(),
  scopes: ['content:read', 'content:draft'],
  actor: { kind: 'agent', id: o.agentGrant, clientId: 'agent-app' },
  agentLimiter: unlimited,
});
/** The CMS's agent drawer saving a draft for the person. */
const drawer = (): Caller => person('editor', CMS_AGENT_CLIENT_ID);

const spot = async () => (await scope().spots.get(o.templateSpot))!;
const edit = async (caller: Caller, durationMs: number, ifVersion?: number) =>
  (await call(caller, 'update_spot', { spotId: o.templateSpot, durationMs, ...(ifVersion ? { ifVersion } : {}) })).spot.version as number;
const draftOf = (kind: 'spot' | 'playlist' = 'spot', id = o.templateSpot) =>
  call(person('viewer'), 'get_agent_draft', kind === 'spot' ? { spotId: id } : { playlistId: id });

describe("an agent's draft of a spot", () => {
  it("is its proposal, by name, with what it changes against the published version; Reject puts the person's edit back, and its Undo the agent's", async () => {
    await call(person('owner'), 'publish', {});
    const live = (await spot()).durationMs;
    // A person edits after the publish, then the agent edits on top.
    const mine = await edit(person(), 11_000, (await spot()).rowVersion);
    expect(await draftOf()).toMatchObject({ proposed: false, by: null });
    const theirs = await edit(agent(), 12_000, mine);
    const proposal = await draftOf();
    expect(proposal).toMatchObject({
      proposed: true,
      rejected: false,
      version: theirs,
      by: { kind: 'mcp', id: o.agentGrant, clientId: 'agent-app', name: 'Seeded agent' },
      changes: [{ field: 'durationMs', in: null, was: live, now: 12_000 }],
    });

    // Reject: the person's 11 s, not the published version.
    const rejected = await call(person(), 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: theirs });
    expect(rejected).toMatchObject({ rejected: true, spot: { durationMs: 11_000, version: theirs + 1 } });
    expect(await draftOf()).toMatchObject({ proposed: false, rejected: true, by: null });
    // Its Undo: the agent's back, a proposal again.
    const undone = await call(person(), 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: theirs + 1 });
    expect(undone).toMatchObject({ rejected: false, spot: { durationMs: 12_000 } });
    expect(await draftOf()).toMatchObject({ proposed: true, by: { name: 'Seeded agent' } });
    // The audit log names the person for each.
    const rows = (await scope().auditLog.list({ limit: 2, target: { kind: 'spot', id: o.templateSpot } })).map((r) => [r.action, r.actorKind]);
    expect(rows).toEqual([
      ['revert_spot_draft', 'user'],
      ['revert_spot_draft', 'user'],
    ]);
  });

  it("over a draft no person changed since its publish, Reject puts the published version back; the drawer's saves are proposals too", async () => {
    await call(person('owner'), 'publish', {});
    const live = await spot();
    const theirs = await edit(drawer(), 14_000, live.rowVersion);
    expect(await draftOf()).toMatchObject({ proposed: true, by: { kind: 'drawer', id: `${o.orgId}-editor` } });
    await call(person(), 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: theirs });
    expect((await spot()).durationMs).toBe(live.durationMs);
  });

  it("carries the person's draft's sample-text marks back with it (#392)", async () => {
    const marks = JSON.stringify({ texts: ['headline'], lists: {} });
    await env.DB.prepare('UPDATE spots SET sample_fields_json = ? WHERE id = ?').bind(marks, o.templateSpot).run();
    const before = (await spot()).rowVersion;
    const theirs = await edit(agent(), 12_000, before);
    await env.DB.prepare('UPDATE spots SET sample_fields_json = NULL WHERE id = ?').bind(o.templateSpot).run();
    await call(person(), 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: theirs });
    expect((await spot()).sampleFieldsJson).toBe(marks);
  });

  it('ends with a Keep, a publish, a person editing it, or the spot deleted', async () => {
    const proposed = async () => (await scope().draftSnapshots.get('spot', o.templateSpot))?.holds ?? null;
    let v = await edit(agent(), 12_000, (await spot()).rowVersion);
    expect(await proposed()).toBe('person');
    await call(person(), 'keep_spot_draft', { spotId: o.templateSpot, ifVersion: v });
    expect(await proposed()).toBeNull();
    expect((await spot()).durationMs).toBe(12_000);

    v = await edit(agent(), 13_000, v);
    await call(person('owner'), 'publish', {});
    expect(await proposed()).toBeNull();
    expect(published(await spot())?.durationMs).toBe(13_000);

    v = await edit(agent(), 14_000, v);
    await edit(person(), 15_000, v);
    expect(await proposed()).toBeNull();
    expect(await dispatch(registry, 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: v + 1 }, person())).toMatchObject({
      ok: false,
      error: 'conflict',
    });

    // Deleted: what was kept goes with it, so a spot made again with its id starts with none.
    const other = await scope().spots.insert({ name: 'Doomed', kind: 'url', durationMs: 5_000, url: 'https://example.com/a' });
    await call(agent(), 'update_spot', { spotId: other.id, url: 'https://example.com/b', ifVersion: other.rowVersion });
    expect(await scope().draftSnapshots.get('spot', other.id)).toBeDefined();
    await scope().commit(scope().spots.stage.delete(other.id).writes);
    expect(await scope().draftSnapshots.get('spot', other.id)).toBeUndefined();
  });

  it('holds every write to the version shown: a stale Reject or Keep, and one an agent edit lands under, write nothing', async () => {
    const theirs = await edit(agent(), 12_000, (await spot()).rowVersion);
    for (const name of ['revert_spot_draft', 'keep_spot_draft'])
      expect(await dispatch(registry, name, { spotId: o.templateSpot, ifVersion: theirs - 1 }, person()), name).toMatchObject({
        ok: false,
        error: 'conflict',
        details: { version: theirs },
      });
    // The agent edits again between the Reject's read and its batch: refused, and the agent's newer draft stays.
    const raced = racing(person(), () => edit(agent(), 13_000));
    expect(await dispatch(registry, 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: theirs }, raced)).toMatchObject({ ok: false, error: 'conflict' });
    expect((await spot()).durationMs).toBe(13_000);
    expect((await scope().draftSnapshots.get('spot', o.templateSpot))?.holds).toBe('person');
  });

  it("never loses a person's edit to an agent's write without ifVersion: one landing under it refuses the agent", async () => {
    const start = (await spot()).rowVersion;
    const raced = racing(agent(), () => edit(person(), 11_000, start));
    expect(await dispatch(registry, 'update_spot', { spotId: o.templateSpot, durationMs: 12_000 }, raced)).toMatchObject({ ok: false, error: 'conflict' });
    expect((await spot()).durationMs).toBe(11_000);
    expect(await scope().draftSnapshots.get('spot', o.templateSpot)).toBeUndefined();
  });

  it('is decided by people only: an agent, over /mcp or the drawer, may not reject or keep', async () => {
    const theirs = await edit(agent(), 12_000, (await spot()).rowVersion);
    for (const caller of [agent(), drawer()])
      for (const name of ['revert_spot_draft', 'keep_spot_draft'])
        expect(await dispatch(registry, name, { spotId: o.templateSpot, ifVersion: theirs }, caller), name).toMatchObject({ ok: false, error: 'forbidden' });
  });
});

describe("an agent's draft of a playlist", () => {
  it("puts the person's order back on Reject, and the agent's on its Undo; it changes the items, by spot id", async () => {
    await call(person('owner'), 'publish', {});
    const start = (await scope().playlists.get(o.playlist))!;
    const mine = (await call(person(), 'update_playlist', { playlistId: o.playlist, spotIds: [o.imageSpot, o.templateSpot], ifVersion: start.rowVersion }))
      .playlist.version as number;
    const theirs = (await call(agent(), 'update_playlist', { playlistId: o.playlist, spotIds: [o.imageSpot], name: 'Agent order', ifVersion: mine })).playlist
      .version as number;
    const proposal = await draftOf('playlist', o.playlist);
    expect(proposal).toMatchObject({ proposed: true, by: { name: 'Seeded agent' } });
    expect(proposal.changes.map((c: { field: string }) => c.field)).toEqual(['items', 'name']);
    expect(proposal.changes[0]).toMatchObject({ now: [o.imageSpot] });

    const back = await call(person(), 'revert_playlist_draft', { playlistId: o.playlist, ifVersion: theirs });
    expect(back).toMatchObject({ rejected: true, playlist: { name: start.name, spotIds: [o.imageSpot, o.templateSpot] } });
    expect(await call(person(), 'revert_playlist_draft', { playlistId: o.playlist, ifVersion: theirs + 1 })).toMatchObject({
      rejected: false,
      playlist: { name: 'Agent order', spotIds: [o.imageSpot] },
    });
    await call(person(), 'keep_playlist_draft', { playlistId: o.playlist, ifVersion: theirs + 2 });
    expect(await draftOf('playlist', o.playlist)).toMatchObject({ proposed: false, rejected: false });
  });
});

describe('the races and paths of review round 1 (#410)', () => {
  const kept = async () => (await scope().draftSnapshots.get('spot', o.templateSpot))?.holds ?? null;
  const decisions = async (action: string) =>
    (await scope().auditLog.list({ limit: 20, target: { kind: 'spot', id: o.templateSpot } })).filter((r) => r.action === action).length;

  it('refuses an edit that changes nothing, and never keeps a draft without the draft still at the version read', async () => {
    const theirs = await edit(agent(), 12_000, (await spot()).rowVersion);
    expect(await dispatch(registry, 'update_spot', { spotId: o.templateSpot }, person())).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await kept()).toBe('person');
    // A kept draft written from a read the draft has since moved on from: the batch writes nothing.
    const read = await spot();
    await edit(person(), 13_000, theirs);
    await expect(scope().commit(scope().draftSnapshots.stage.propose('spot', read, { contentJson: '{}', sampleFieldsJson: null }).writes)).rejects.toThrow();
    await expect(
      scope().commit(scope().draftSnapshots.stage.keep('spot', read, 'agent', { contentJson: '{}', sampleFieldsJson: null }).writes),
    ).rejects.toThrow();
    expect(await kept()).toBeNull();
  });

  it("a Keep committed between a Reject's read and its batch refuses the Reject: the kept draft stays, nothing set aside", async () => {
    const theirs = await edit(agent(), 12_000, (await spot()).rowVersion);
    const raced = racing(person(), () => call(person(), 'keep_spot_draft', { spotId: o.templateSpot, ifVersion: theirs }));
    expect(await dispatch(registry, 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: theirs }, raced)).toMatchObject({
      ok: false,
      error: 'conflict',
      message: expect.stringContaining('kept, rejected or published meanwhile'),
    });
    expect((await spot()).durationMs).toBe(12_000);
    expect(await kept()).toBeNull();
  });

  it("a publish committed between a Reject's read and its batch refuses the Reject: what was published stays the draft", async () => {
    const theirs = await edit(agent(), 12_000, (await spot()).rowVersion);
    const raced = racing(person(), () => call(person('owner'), 'publish', {}));
    expect(await dispatch(registry, 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: theirs }, raced)).toMatchObject({ ok: false, error: 'conflict' });
    expect(published(await spot())?.durationMs).toBe(12_000);
    expect((await spot()).durationMs).toBe(12_000);
    expect(await kept()).toBeNull();
  });

  it('of two Keeps, or a publish and a Keep, one decides it: the other is refused, with no second audit row', async () => {
    let theirs = await edit(agent(), 12_000, (await spot()).rowVersion);
    let raced = racing(person(), () => call(person(), 'keep_spot_draft', { spotId: o.templateSpot, ifVersion: theirs }));
    expect(await dispatch(registry, 'keep_spot_draft', { spotId: o.templateSpot, ifVersion: theirs }, raced)).toMatchObject({ ok: false, error: 'conflict' });
    expect(await decisions('keep_spot_draft')).toBe(1);

    theirs = await edit(agent(), 13_000, theirs);
    raced = racing(person(), () => call(person('owner'), 'publish', {}));
    expect(await dispatch(registry, 'keep_spot_draft', { spotId: o.templateSpot, ifVersion: theirs }, raced)).toMatchObject({ ok: false, error: 'conflict' });
    expect(await decisions('keep_spot_draft')).toBe(1);
    expect(await kept()).toBeNull();
  });

  it('a publish that covers the draft ends the proposal though the draft needs no promotion: edited back to as published, or rejected back', async () => {
    await call(person('owner'), 'publish', {});
    const live = await spot();
    // A person edits, then the agent edits it back to what is published: nothing to promote.
    const mine = await edit(person(), 13_000, live.rowVersion);
    await edit(agent(), live.durationMs, mine);
    expect(await kept()).toBe('person');
    await call(person('owner'), 'publish', {});
    expect(await kept()).toBeNull();
    expect(await draftOf()).toMatchObject({ proposed: false, rejected: false });

    // Rejected back to the published version, then a publish pinning it: the set-aside agent's draft goes too.
    const theirs = await edit(agent(), 14_000, (await spot()).rowVersion);
    await call(person(), 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: theirs });
    expect(await kept()).toBe('agent');
    const now = await spot();
    await call(person('owner'), 'publish', { drafts: [{ kind: 'spot', id: now.id, version: now.rowVersion }] });
    expect(await kept()).toBeNull();
    // A publish that covers nothing kept still writes nothing.
    const audit = (await scope().auditLog.list({ limit: 50 })).length;
    expect(await call(person('owner'), 'publish', {})).toMatchObject({ publish: null });
    expect((await scope().auditLog.list({ limit: 50 })).length).toBe(audit);
  });
});

describe("the agents in a draft's audit log strip (#410)", () => {
  it('are named by their plain name; one whose name may not be shown is unnamed but connected; one disconnected is gone', async () => {
    const theirs = await edit(agent(), 12_000, (await spot()).rowVersion);
    await call(person(), 'revert_spot_draft', { spotId: o.templateSpot, ifVersion: theirs });
    // Rejected: no proposal, but the strip still names the agent that wrote it.
    expect(await draftOf()).toMatchObject({ proposed: false, by: null, agents: [{ id: o.agentGrant, name: 'Seeded agent', gone: false }] });
    // A name that reads as SignForge is not shown (as /connect withholds it), yet the agent is still connected.
    await env.DB.prepare('UPDATE agent_grants SET client_name = ? WHERE id = ?').bind('SI6NFOR6E', o.agentGrant).run();
    expect((await draftOf()).agents).toEqual([{ id: o.agentGrant, name: null, gone: false }]);
    await env.DB.prepare('UPDATE agent_grants SET revoked_at = ? WHERE id = ?').bind(Date.now(), o.agentGrant).run();
    expect((await draftOf()).agents).toEqual([{ id: o.agentGrant, name: null, gone: true }]);
  });
});

describe('a publish of every draft, raced by an agent (review round 2 of #410)', () => {
  const kept = async () => (await scope().draftSnapshots.get('spot', o.templateSpot))?.holds ?? null;
  /** The owner, whose publish reads which drafts have one kept only after `before` has run: an edit during its compile. */
  const duringCompile = (before: () => Promise<unknown>): Caller => {
    const base = person('owner');
    const org = base.org;
    let ran = false;
    const draftSnapshots = {
      ...org.draftSnapshots,
      kept: async () => {
        if (!ran) {
          ran = true;
          await before();
        }
        return org.draftSnapshots.kept();
      },
    };
    return { ...base, org: new Proxy(org, { get: (t, k) => (k === 'draftSnapshots' ? draftSnapshots : Reflect.get(t, k)) }) };
  };

  it("never clears an agent's new proposal it did not publish: one made during its compile is published with it, or kept", async () => {
    await call(person('owner'), 'publish', {});
    const live = await spot();
    // The agent edits the published, unchanged spot while the publish compiles.
    expect(
      await dispatch(
        registry,
        'publish',
        {},
        duringCompile(() => edit(agent(), 12_000, live.rowVersion)),
      ),
    ).toMatchObject({ ok: true });
    // Run again from a fresh read, it published the agent's edit: what the proposal was cleared for is on screens.
    expect(published(await spot())?.durationMs).toBe(12_000);
    expect(await kept()).toBeNull();
  });

  it("never clears the person's draft kept under an agent's edit landing before its batch: it publishes what it then reads", async () => {
    await call(person('owner'), 'publish', {});
    const live = await spot();
    const mine = await edit(person(), 13_000, live.rowVersion);
    // The agent edits it back to as published: nothing to promote, the person's draft kept.
    const back = await edit(agent(), live.durationMs, mine);
    expect(await kept()).toBe('person');
    // The agent edits again before the publish's batch.
    const raced = racing(person('owner'), () => edit(agent(), 14_000, back));
    expect(await dispatch(registry, 'publish', {}, raced)).toMatchObject({ ok: true });
    // Never the person's draft cleared while the agent's edit is no more than a draft: the retry published that edit.
    expect(published(await spot())?.durationMs).toBe(14_000);
    expect(await kept()).toBeNull();
  });
});
