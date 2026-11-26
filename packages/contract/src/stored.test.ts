// What a screen stores, read by this release (#156, review of #580): the previous release's `sf build` output for
// examples/demo and examples/live, and snapshots as the server writes them, made from packages/feeds' test fixtures.
// An offline Pi keeps playing its stored copies across an update only while they still read as the manifest's and
// snapshot's shapes: a shape that narrows (a spot kind dropped, a field made required) would make it ignore them.
// Refresh the files from a release's build when it ships (`sf build examples/<name> --out <dir>`, its manifest.json),
// never by hand.
import { describe, expect, it } from 'vitest';
import demo from '../test/stored/demo-manifest.json';
import live from '../test/stored/live-manifest.json';
import snapshots from '../test/stored/snapshots.json';
import { dataSnapshotShape, manifestShape } from './validate.ts';

describe("the previous release's stored copies", () => {
  for (const [name, m] of Object.entries({ demo, live })) {
    it(`reads ${name}'s manifest as the manifest's shape, every key it was stored with kept`, () => {
      expect(manifestShape.read(m)).toEqual({ ok: true, value: m });
    });
  }

  it('reads each stored snapshot as the snapshot shape, every key kept', () => {
    expect(snapshots).toHaveLength(4);
    for (const s of snapshots) expect(dataSnapshotShape.read(s)).toEqual({ ok: true, value: s });
  });
});
