// The Screen schedule (#330): which entries reach a screen, and in what order it gets them. The publish, `sf build` and
// the CMS's week view all ask this, so these cases hold for every one of them.
import { describe, expect, it } from 'vitest';
import { reaches, screenSchedule, type TargetedEntry } from '../src/schedule';

const counter = { id: 'counter', groups: ['front', 'tills'] };
const entry = (id: string, target: TargetedEntry['target'], targetId: string | undefined, order: number): TargetedEntry => ({
  id,
  playlist: 'p',
  priority: 1,
  target,
  ...(targetId === undefined ? {} : { targetId }),
  order,
});

describe('which entries reach a screen', () => {
  it.each([
    ['every screen', entry('e', 'org', undefined, 0), true],
    ['one of its groups', entry('e', 'group', 'tills', 0), true],
    ['another group', entry('e', 'group', 'kitchen', 0), false],
    ['a group entry with no group', entry('e', 'group', undefined, 0), false],
    ['the screen', entry('e', 'screen', 'counter', 0), true],
    ['another screen', entry('e', 'screen', 'lobby', 0), false],
    ['a screen entry with no screen', entry('e', 'screen', undefined, 0), false],
    ['a screen entry naming one of its groups', entry('e', 'screen', 'front', 0), false],
  ])('%s: %s', (_, e, reached) => {
    expect(reaches(e, counter)).toBe(reached);
  });
});

describe("a screen's schedule", () => {
  it('keeps the entries that reach it, as the contract has them, without their target ids or order', () => {
    expect(
      screenSchedule([entry('org', 'org', undefined, 1), entry('kitchen', 'group', 'kitchen', 2), entry('mine', 'screen', 'counter', 3)], counter),
    ).toEqual([
      { id: 'org', playlist: 'p', priority: 1, target: 'org' },
      { id: 'mine', playlist: 'p', priority: 1, target: 'screen' },
    ]);
  });

  it('orders by order, then id: of two otherwise tied entries the screen plays the later', () => {
    const ids = screenSchedule(
      [entry('c', 'org', undefined, 2), entry('b', 'org', undefined, 1), entry('a', 'group', 'front', 2), entry('d', 'org', undefined, 1)],
      counter,
    ).map((e) => e.id);
    expect(ids).toEqual(['b', 'd', 'a', 'c']);
  });

  it('puts a CMS draft, ordered after every published entry, last, and drafts among themselves by id', () => {
    const draft = Number.POSITIVE_INFINITY;
    const ids = screenSchedule(
      [entry('z-draft', 'org', undefined, draft), entry('a-draft', 'org', undefined, draft), entry('published', 'org', undefined, 5)],
      counter,
    ).map((e) => e.id);
    expect(ids).toEqual(['published', 'a-draft', 'z-draft']);
  });
});
