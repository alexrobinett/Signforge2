import { describe, expect, it } from 'vitest';
import { PlayLedger } from './plays';

const H = Date.UTC(2026, 10, 17, 13);
const MIN = 60_000;

describe('PlayLedger', () => {
  it('counts plays per UTC hour and spot, and sends an hour only once it has ended', () => {
    const l = PlayLedger.fresh('ep1');
    l.record(H + 5 * MIN, 'menu', 8000);
    l.record(H + 6 * MIN, 'menu', 8000);
    l.record(H + 7 * MIN, 'news', 10_000);
    expect(l.batch(H + 30 * MIN)).toEqual({ epoch: 'ep1', seq: 0, counts: [] });
    l.record(H + 61 * MIN, 'menu', 8000);
    expect(l.batch(H + 62 * MIN)).toEqual({
      epoch: 'ep1',
      seq: 1,
      counts: [
        { hour: '2026-11-17T13:00Z', spot: 'menu', plays: 2, ms: 16_000 },
        { hour: '2026-11-17T13:00Z', spot: 'news', plays: 1, ms: 10_000 },
      ],
    });
  });

  it('sends the same batch again until it is acknowledged in its epoch, and plays meanwhile wait for the next', () => {
    const l = PlayLedger.fresh('ep1');
    l.record(H, 'menu', 1000);
    const first = l.batch(H + 61 * MIN);
    l.record(H + 61 * MIN, 'menu', 1000);
    expect(l.batch(H + 125 * MIN)).toEqual(first);
    l.acknowledge('other', 5);
    expect(l.batch(H + 125 * MIN)).toEqual(first);
    l.acknowledge('ep1', 1);
    expect(l.batch(H + 125 * MIN)).toEqual({ epoch: 'ep1', seq: 2, counts: [{ hour: '2026-11-17T14:00Z', spot: 'menu', plays: 1, ms: 1000 }] });
  });

  it('survives a round trip through storage, and caps a batch', () => {
    const l = PlayLedger.fresh('ep1');
    for (let i = 0; i < 5; i++) l.record(H, `s${i}`, 1000);
    const back = PlayLedger.restore(JSON.parse(JSON.stringify(l.toJSON())), () => 'new')!;
    const b = back.batch(H + 2 * 3_600_000, 3);
    expect(b.seq).toBe(1);
    expect(b.counts.map((c) => c.spot)).toEqual(['s0', 's1', 's2']);
    back.acknowledge('ep1', 1);
    expect(back.batch(H + 2 * 3_600_000, 3).counts.map((c) => c.spot)).toEqual(['s3', 's4']);
  });

  it('starts a new epoch at seq 1 when there is nothing stored, with a random id', () => {
    const l = PlayLedger.restore(undefined, () => 'fresh-id');
    expect(l.toJSON()).toMatchObject({ epoch: 'fresh-id', seq: 0 });
    expect(PlayLedger.restore({ nonsense: true }, () => 'again').toJSON()).toMatchObject({ epoch: 'again' });
  });
});
