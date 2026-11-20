// The versioned draft module on its own (src/state/versioned-draft.ts). The save is a fake whose
// answers the test holds and lets go one by one; autosave runs on a fake clock the test moves.
// Nothing waits on real time.
import { describe, expect, it, vi } from 'vitest';
import { ToolCallError } from '../src/lib/tools';
import { autosave, createVersionedDrafts, shown, type Clock, type Draft, type Drafts, type Saved } from '../src/state/versioned-draft';

// tools.ts names the tab's org from the page's router, which this test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));

const A = 'org_a';
const B = 'org_b';

/** A clock the test moves: timers run only when `tick` passes them. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  const clock: Clock = {
    now: () => now,
    after(ms, run) {
      const t = { at: now + ms, run };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
  };
  const tick = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.run();
  };
  return { clock, tick };
}

/** One save sent: what it carried, and its answer, held until the test gives it. */
interface Sent {
  key: string;
  draft: Draft<Edit>;
  context: string;
  moved: (version: number) => void;
  answer: (saved: Saved<Edit>) => void;
  refuse: (err: unknown) => void;
}

type Edit = { name: string };

function setup({ invalid, gone }: { invalid?: (d: Draft<Edit>) => boolean; gone?: (err: unknown, key: string) => boolean } = {}) {
  let drafts: Drafts<Edit> = {};
  let org: string | undefined = A;
  let ids = 0;
  const sent: Sent[] = [];
  const { clock, tick } = fakeClock();
  const module = createVersionedDrafts<Edit, string>({
    state: { read: () => drafts, write: (change) => (drafts = change(drafts)) },
    save: ({ key, draft, context, moved }) =>
      new Promise<Saved<Edit>>((resolve, reject) => sent.push({ key, draft, context, moved, answer: resolve, refuse: reject })),
    makeId: () => `key_${++ids}`,
    currentOrg: () => org,
    clock,
    ...(invalid ? { invalid } : {}),
    ...(gone ? { gone } : {}),
  });
  return {
    module,
    sent,
    tick,
    clock,
    draft: (key: string) => drafts[key],
    drafts: () => drafts,
    switchTo: (id: string) => (org = id),
  };
}

const start = (record: string | null, version: number | null, name = '', orgId = A) => ({ orgId, record, version, edit: { name } });
const named = (name: string) => () => ({ name });

/** Lets the module's awaits run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const stale = () => new ToolCallError('conflict', 'stale', { version: 9 });

describe('saves run one at a time', () => {
  it('a save asked for while one runs is one follow-up with the latest edit, on the version the first returned', async () => {
    const { module, sent, draft } = setup();
    module.edit('spt_1', start('spt_1', 4), named('One'));
    const first = module.save('spt_1', 'first');
    await settle();
    expect(sent.map((s) => [s.draft.edit.name, s.draft.version])).toEqual([['One', 4]]);

    module.update('spt_1', named('Two'));
    const second = module.save('spt_1', 'second');
    module.update('spt_1', named('Three'));
    const third = module.save('spt_1', 'third');
    await settle();
    expect(sent).toHaveLength(1);

    sent[0]!.answer({ version: 5 });
    await settle();
    expect(sent.map((s) => [s.draft.edit.name, s.draft.version, s.context])).toEqual([
      ['One', 4, 'first'],
      ['Three', 5, 'third'],
    ]);
    expect(draft('spt_1')).toMatchObject({ status: 'saving', pending: true });

    let resolved = false;
    void Promise.all([first, second, third]).then(() => (resolved = true));
    await settle();
    expect(resolved).toBe(false);
    sent[1]!.answer({ version: 6 });
    await settle();
    expect(resolved).toBe(true);
    expect(draft('spt_1')).toMatchObject({ status: 'saved', pending: false, version: 6, edit: { name: 'Three' } });
  });

  it('sends the edit as it was when the save was asked for; an edit right after waits for the next save', async () => {
    const { module, sent, draft } = setup();
    module.edit('general', start('settings', 1), named('asked'));
    void module.save('general', '');
    module.update('general', named('after'));
    await settle();
    expect(sent.map((s) => s.draft.edit.name)).toEqual(['asked']);
    sent[0]!.answer({ version: 2 });
    await settle();
    expect(draft('general')).toMatchObject({ status: 'unsaved', edit: { name: 'after' }, version: 2 });
  });

  it('awaiting a save with nothing new resolves with the save in flight, and sends nothing more', async () => {
    const { module, sent } = setup();
    module.edit('spt_1', start('spt_1', 1), named('One'));
    void module.save('spt_1', '');
    await settle();
    let done = false;
    void module.save('spt_1', '').then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    sent[0]!.answer({ version: 2 });
    await settle();
    expect(done).toBe(true);
    expect(sent).toHaveLength(1);
    // Saved: nothing to send, and it resolves at once.
    await module.save('spt_1', '');
    expect(sent).toHaveLength(1);
  });

  it('an edit while a save runs leaves the draft unsaved after its answer, on the new version', async () => {
    const { module, sent, draft } = setup();
    module.edit('spt_1', start('spt_1', 1), named('One'));
    void module.save('spt_1', '');
    await settle();
    module.update('spt_1', named('Two'));
    sent[0]!.answer({ version: 2 });
    await settle();
    expect(draft('spt_1')).toMatchObject({ status: 'unsaved', pending: false, version: 2, edit: { name: 'Two' } });
  });

  it('two drafts of one record wait for each other: the second sends the version the first made', async () => {
    const { module, sent } = setup();
    module.edit('general', start('settings', 1), named('a'));
    module.edit('screens', start('settings', 1), named('b'));
    void module.save('general', '');
    void module.save('screens', '');
    await settle();
    expect(sent.map((s) => s.key)).toEqual(['general']);
    sent[0]!.answer({ version: 2 });
    await settle();
    expect(sent.map((s) => [s.key, s.draft.version])).toEqual([
      ['general', 1],
      ['screens', 2],
    ]);
  });

  it('drafts of different records do not wait for each other', async () => {
    const { module, sent } = setup();
    module.edit('a', start('pls_a', 1), named('a'));
    module.edit('b', start('pls_b', 1), named('b'));
    void module.save('a', '');
    void module.save('b', '');
    await settle();
    expect(sent.map((s) => s.key)).toEqual(['a', 'b']);
  });
});

describe('after a save', () => {
  it("moves the record's other drafts on the old version to the new one, not one on an older version or in another org", async () => {
    const { module, sent, draft } = setup();
    module.edit('general', start('settings', 3), named('a'));
    module.edit('screens', start('settings', 3), named('b'));
    module.edit('publishing', start('settings', 2), named('c'));
    module.edit('kit', start('bk_1', 3), named('d'));
    module.edit('elsewhere', start('settings', 3, 'e', B), named('e'));
    void module.save('general', '');
    await settle();
    sent[0]!.answer({ version: 4 });
    await settle();
    expect([draft('general'), draft('screens'), draft('publishing'), draft('kit'), draft('elsewhere')].map((d) => d?.version)).toEqual([4, 4, 2, 3, 3]);
  });

  it('keeps the version a save of several writes reached, when a later write fails', async () => {
    const { module, sent, draft } = setup();
    module.edit('general', start('settings', 1), named('a'));
    module.edit('screens', start('settings', 1), named('b'));
    void module.save('general', '');
    await settle();
    sent[0]!.moved(2);
    sent[0]!.refuse(new ToolCallError('error', 'Could not rename the organization.'));
    await settle();
    expect(draft('general')).toMatchObject({ version: 2, status: 'unsaved', error: 'Could not rename the organization.', stale: false });
    expect(draft('screens')?.version).toBe(2);
  });

  it('a saved draft is shown and built on while the record is at its version; once the record moves on, the record is (review of #153, 1)', async () => {
    const { module, sent, draft } = setup();
    module.edit('spt_1', start('spt_1', 4, 'Old'), named('Mine '));
    void module.save('spt_1', '');
    await settle();
    sent[0]!.answer({ version: 5 });
    await settle();
    // The record as saved (trimmed, at 5): the page keeps showing what was typed, and builds on it.
    expect(shown(draft('spt_1'), 5)).toEqual({ name: 'Mine ' });
    module.edit('spt_1', start('spt_1', 5, 'Mine'), (e) => ({ name: `${e.name}!` }));
    void module.save('spt_1', '');
    await settle();
    expect(sent[1]!.draft).toMatchObject({ edit: { name: 'Mine !' }, version: 5 });
    sent[1]!.answer({ version: 6 });
    await settle();

    // Someone else renames it, and the page reads it at 7: the page shows theirs, and the next edit builds on theirs.
    expect(shown(draft('spt_1'), 7)).toBeNull();
    module.edit('spt_1', start('spt_1', 7, 'Theirs'), (e) => ({ name: `${e.name}!` }));
    void module.save('spt_1', '');
    await settle();
    expect(sent[2]!.draft).toMatchObject({ edit: { name: 'Theirs!' }, version: 7 });
  });

  it("keeps, once saved, only what the answer says still stands: a field outside the record's version is not shown or sent again (re-check of #153, 1)", async () => {
    const { module, sent, draft } = setup();
    module.edit('general', start('settings', 1), named('Renamed'));
    void module.save('general', '');
    await settle();
    sent[0]!.answer({ version: 2, edit: { name: '' } });
    await settle();
    expect(shown(draft('general'), 2)).toEqual({ name: '' });
    module.edit('general', start('settings', 2), (e) => ({ name: `${e.name}x` }));
    expect(draft('general')?.edit).toEqual({ name: 'x' });
  });

  it('a draft opened again at the same key while the save is out keeps its older version, so its own save conflicts (re-check of #153)', async () => {
    const { module, sent, draft } = setup();
    module.open('settings:scr_1', start('scr_1', 3, 'Lobby'));
    module.update('settings:scr_1', named('Front lobby'));
    module.edit('hours:scr_1', start('scr_1', 3), named('hours'));
    void module.save('settings:scr_1', '');
    await settle();
    module.open('settings:scr_1', start('scr_1', 3, 'Lobby'));
    sent[0]!.answer({ version: 4 });
    await settle();
    expect(draft('settings:scr_1')?.version).toBe(3);
    // Another editor's draft of the record, at another key, moves on.
    expect(draft('hours:scr_1')?.version).toBe(4);
  });

  it('the next edit of a saved draft starts from the record as the page holds it now', async () => {
    const { module, sent, draft } = setup();
    module.edit('bk_1', start('bk_1', 1, 'old'), (e) => ({ name: `${e.name}!` }));
    void module.save('bk_1', '');
    await settle();
    sent[0]!.answer({ version: 2 });
    await settle();
    // Someone else saved since, and the page has read it.
    module.edit('bk_1', start('bk_1', 3, 'theirs'), (e) => ({ name: `${e.name}?` }));
    expect(draft('bk_1')).toMatchObject({ version: 3, edit: { name: 'theirs?' }, status: 'unsaved', savedAt: 0 });
  });
});

describe('a conflict', () => {
  it('keeps the edit, marks it stale, saves nothing more, and Reload drops only that draft', async () => {
    const { module, sent, draft } = setup();
    module.edit('general', start('settings', 1), named('mine'));
    module.edit('screens', start('settings', 1), named('other'));
    void module.save('general', '');
    await settle();
    sent[0]!.refuse(stale());
    await settle();
    expect(draft('general')).toMatchObject({ stale: true, error: 'This changed since you opened it.', edit: { name: 'mine' }, version: 1 });

    module.update('general', named('still mine'));
    await module.save('general', '');
    expect(sent).toHaveLength(1);
    expect(draft('general')).toMatchObject({ stale: true, edit: { name: 'still mine' } });

    module.drop('general');
    expect(draft('general')).toBeUndefined();
    expect(draft('screens')).toMatchObject({ edit: { name: 'other' } });
  });

  it('a follow-up asked for meanwhile is not sent after a conflict', async () => {
    const { module, sent } = setup();
    module.edit('spt_1', start('spt_1', 1), named('One'));
    const first = module.save('spt_1', '');
    await settle();
    module.update('spt_1', named('Two'));
    const second = module.save('spt_1', '');
    sent[0]!.refuse(stale());
    await Promise.all([first, second]);
    expect(sent).toHaveLength(1);
  });

  it('a record the store says is deleted is gone: its refusal is shown, and nothing more is saved', async () => {
    const { module, sent, draft } = setup({ gone: (err) => err instanceof ToolCallError && err.message === 'playlist pls_1 not found' });
    module.edit('pls_1', start('pls_1', 1), named('One'));
    void module.save('pls_1', '');
    await settle();
    sent[0]!.refuse(new ToolCallError('not_found', 'playlist pls_1 not found'));
    await settle();
    expect(draft('pls_1')).toMatchObject({ gone: true, error: 'playlist pls_1 not found' });
    module.update('pls_1', named('Two'));
    await module.save('pls_1', '');
    expect(sent).toHaveLength(1);
  });

  it('a not_found about a row the edit refers to (a deleted playlist) is shown, and a fixed save is sent (review of #153, 3)', async () => {
    const { module, sent, draft } = setup({ gone: (err) => err instanceof ToolCallError && err.message === 'playlist pls_1 not found' });
    module.edit('pls_1', start('pls_1', 1), named('One'));
    void module.save('pls_1', '');
    await settle();
    sent[0]!.refuse(new ToolCallError('not_found', 'spot spt_9 not found'));
    await settle();
    expect(draft('pls_1')).toMatchObject({ gone: false, error: 'spot spt_9 not found', status: 'unsaved' });
    module.update('pls_1', named('Two'));
    void module.save('pls_1', '');
    await settle();
    expect(sent).toHaveLength(2);
  });

  it('without a `gone` rule, and for a create, a not_found is only shown (review of #153, 3)', async () => {
    const plain = setup();
    plain.module.open('dialog', start(null, null, 'Breakfast'));
    void plain.module.save('dialog', '');
    await settle();
    plain.sent[0]!.refuse(new ToolCallError('not_found', 'playlist pls_deleted not found'));
    await settle();
    expect(plain.draft('dialog')).toMatchObject({ gone: false, error: 'playlist pls_deleted not found' });
    plain.module.update('dialog', named('Lunch'));
    void plain.module.save('dialog', '');
    await settle();
    expect(plain.sent).toHaveLength(2);

    const creating = setup({ gone: () => true });
    creating.module.open('dialog', start(null, null, 'Breakfast'));
    void creating.module.save('dialog', '');
    await settle();
    creating.sent[0]!.refuse(new ToolCallError('not_found', 'playlist pls_deleted not found'));
    await settle();
    expect(creating.draft('dialog')).toMatchObject({ gone: false, error: 'playlist pls_deleted not found' });
  });

  it('another refusal says why and is sent again only when asked', async () => {
    const { module, sent, draft } = setup();
    module.edit('spt_1', start('spt_1', 1), named('One'));
    await Promise.all([module.save('spt_1', ''), settle().then(() => sent[0]!.refuse(new ToolCallError('error', 'Refused')))]);
    expect(draft('spt_1')).toMatchObject({ status: 'unsaved', error: 'Refused', stale: false });
    void module.save('spt_1', '');
    await settle();
    expect(sent).toHaveLength(2);
    expect(draft('spt_1')).toMatchObject({ status: 'saving', error: null });
  });
});

describe('the org guard', () => {
  it('a draft is not saved while the tab shows another org', async () => {
    const { module, sent, switchTo } = setup();
    module.edit('general', start('settings', 1), named('a'));
    switchTo(B);
    await module.save('general', '');
    expect(sent).toHaveLength(0);
  });

  it('a late answer for a left org changes nothing: no version moves, nothing is marked saved', async () => {
    const { module, sent, draft, switchTo } = setup();
    module.edit('general', start('settings', 1), named('a'));
    module.edit('screens', start('settings', 1), named('b'));
    void module.save('general', '');
    await settle();
    switchTo(B);
    sent[0]!.moved(2);
    sent[0]!.answer({ version: 2 });
    await settle();
    expect(draft('general')).toMatchObject({ version: 1, status: 'unsaved', pending: false, savedAt: null });
    expect(draft('screens')?.version).toBe(1);
  });

  it('a late refusal for a left org shows nothing', async () => {
    const { module, sent, draft, switchTo } = setup();
    module.edit('general', start('settings', 1), named('a'));
    void module.save('general', '');
    await settle();
    switchTo(B);
    sent[0]!.refuse(stale());
    await settle();
    expect(draft('general')).toMatchObject({ stale: false, error: null });
  });

  it('a draft made in another org under the same key is replaced, never continued', () => {
    const { module, draft } = setup();
    module.edit('general', start('settings', 1, 'A'), (e) => ({ name: `${e.name}+` }));
    module.edit('general', start('settings', 7, 'B', B), (e) => ({ name: `${e.name}+` }));
    expect(draft('general')).toMatchObject({ orgId: B, version: 7, edit: { name: 'B+' } });
  });

  it('forget drops every draft, and a save on its way then changes nothing', async () => {
    const { module, sent, drafts } = setup();
    module.edit('general', start('settings', 1), named('a'));
    void module.save('general', '');
    await settle();
    module.forget();
    sent[0]!.answer({ version: 2 });
    await settle();
    expect(drafts()).toEqual({});
  });
});

describe('a draft dropped and opened again at the same key (review of #153, 2)', () => {
  it('saves on its own, after the old one; the old refusal neither clears its save nor leaves it stuck', async () => {
    const { module, sent, draft } = setup();
    module.open('dialog', start(null, null, 'First'));
    const first = module.save('dialog', 'first');
    await settle();
    module.open('dialog', start(null, null, 'Second'));
    const second = module.save('dialog', 'second');
    await settle();
    expect(sent.map((s) => s.draft.edit.name)).toEqual(['First']);

    sent[0]!.refuse(new ToolCallError('error', 'Refused'));
    expect(await first).toMatchObject({ status: 'unsaved', pending: false, error: 'Refused', edit: { name: 'First' } });
    await settle();
    expect(sent.map((s) => s.draft.edit.name)).toEqual(['First', 'Second']);
    expect(draft('dialog')).toMatchObject({ status: 'saving', pending: true, error: null, edit: { name: 'Second' } });
    sent[1]!.answer({ record: 'sch_2' });
    expect(await second).toMatchObject({ status: 'saved', pending: false, record: 'sch_2' });
  });

  it("each save resolves with its own draft's outcome: the old create's record, though its dialog was closed", async () => {
    const { module, sent } = setup();
    module.open('dialog', start(null, null, 'First'));
    const first = module.save('dialog', '');
    await settle();
    module.open('dialog', start(null, null, 'Second'));
    const second = module.save('dialog', '');
    sent[0]!.answer({ record: 'sch_1' });
    await settle();
    sent[1]!.answer({ record: 'sch_2' });
    expect([(await first)?.record, (await second)?.record]).toEqual(['sch_1', 'sch_2']);
  });

  it('a draft refused while a new one waits is not left saving: Save sends it again', async () => {
    const { module, sent, draft } = setup();
    module.open('dialog', start(null, null, 'First'));
    void module.save('dialog', '');
    await settle();
    module.open('dialog', start(null, null, 'Second'));
    void module.save('dialog', '');
    sent[0]!.refuse(new ToolCallError('error', 'Refused'));
    await settle();
    sent[1]!.refuse(new ToolCallError('error', 'Refused too'));
    await settle();
    expect(draft('dialog')).toMatchObject({ status: 'unsaved', pending: false, error: 'Refused too' });
    void module.save('dialog', '');
    await settle();
    expect(sent).toHaveLength(3);
  });
});

describe('a create', () => {
  it('keeps one idempotency key across retries until a save is answered, then names the record it made', async () => {
    const { module, sent, draft } = setup();
    module.open('dialog', start(null, null, 'Lunch'));
    void module.save('dialog', '');
    await settle();
    sent[0]!.refuse(new ToolCallError('network', 'Could not reach SignForge.'));
    await settle();
    void module.save('dialog', '');
    await settle();
    expect(sent[1]!.draft.idempotencyKey).toBe(sent[0]!.draft.idempotencyKey);
    sent[1]!.answer({ record: 'sch_1' });
    await settle();
    expect(draft('dialog')).toMatchObject({ status: 'saved', record: 'sch_1' });
    expect(draft('dialog')?.idempotencyKey).not.toBe(sent[0]!.draft.idempotencyKey);
  });

  it('a dialog opened again is a new create, and the old one’s late answer does not reach it', async () => {
    const { module, sent, draft } = setup();
    module.open('dialog', start(null, null, 'First'));
    void module.save('dialog', '');
    await settle();
    module.open('dialog', start(null, null, 'Second'));
    sent[0]!.answer({ record: 'sch_1' });
    await settle();
    expect(draft('dialog')).toMatchObject({ status: 'unsaved', record: null, edit: { name: 'Second' } });
    expect(draft('dialog')?.idempotencyKey).not.toBe(sent[0]!.draft.idempotencyKey);
  });
});

describe('a draft the server would refuse', () => {
  it('is marked invalid and not sent', async () => {
    const { module, sent, draft } = setup({ invalid: (d) => !d.edit.name.trim() });
    module.edit('spt_1', start('spt_1', 1), named(' '));
    await module.save('spt_1', '');
    expect(sent).toHaveLength(0);
    expect(draft('spt_1')?.status).toBe('invalid');
    module.update('spt_1', named('Fixed'));
    void module.save('spt_1', '');
    await settle();
    expect(sent).toHaveLength(1);
  });
});

describe('autosave', () => {
  it('saves a second after the last edit, once, and each draft on its own clock', async () => {
    const { module, sent, clock, tick } = setup();
    const soon = autosave(clock, 1000, (key) => module.save(key, 'auto'));
    module.edit('a', start('pls_a', 1), named('a1'));
    soon('a');
    tick(600);
    module.update('a', named('a2'));
    soon('a');
    module.edit('b', start('pls_b', 1), named('b1'));
    soon('b');
    tick(600);
    await settle();
    expect(sent).toHaveLength(0);
    tick(400);
    await settle();
    expect(sent.map((s) => [s.key, s.draft.edit.name, s.context])).toEqual([
      ['a', 'a2', 'auto'],
      ['b', 'b1', 'auto'],
    ]);
  });
});
