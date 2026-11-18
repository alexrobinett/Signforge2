// sf build's video check (ffprobe) and the upload check (@signforge/media-check reading the MP4
// header) must reach the same verdict for the same reasons. Run on the media-check fixtures and
// on the clips measured on the Pi: examples/stress/media (scripts/stress-media.sh) and
// spike/pi-perf/rejected-media, when present. Skipped without ffprobe.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkVideo, videoProblems } from '@signforge/media-check';
import { probeVideo } from '../src/video';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = `${root}packages/media-check/test/fixtures/`;

const hasFfprobe = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function verdicts(path: string) {
  const b = new Uint8Array(readFileSync(path));
  const header = await checkVideo(async (offset, length) => b.subarray(offset, offset + length), b.length);
  const probed = probeVideo(path);
  if (probed === null) throw new Error('no ffprobe');
  return { header: header.problems.map((p) => p.code), ffprobe: Array.isArray(probed) ? ['unreadable'] : videoProblems(probed).map((p) => p.code) };
}

// Where they differ, and why. Both reject every one of these except the fragmented file.
const DIFFER: Record<string, { header: string[]; ffprobe: string[] }> = {
  // ffprobe reads a fragmented MP4's frames from its moof boxes; the header check refuses the layout.
  'fragmented.mp4': { header: ['unreadable'], ffprobe: [] },
  // ffprobe reads WebM and names its codec; the header check stops at "not an MP4".
  'vp9.webm': { header: ['unreadable'], ffprobe: ['codec'] },
};

describe.skipIf(!hasFfprobe)('sf build and the upload check agree', () => {
  for (const name of readdirSync(fixtures).filter((f) => !f.endsWith('.sh'))) {
    it(name, async () => {
      const v = await verdicts(fixtures + name);
      if (DIFFER[name]) expect(v).toEqual(DIFFER[name]);
      else expect(v.header).toEqual(v.ffprobe);
    });
  }

  const pi = {
    'examples/stress/media/pan-1080p30.mp4': [],
    'spike/pi-perf/rejected-media/motion-1080p60.mp4': ['fps', 'bitrate'],
  };
  for (const [rel, codes] of Object.entries(pi)) {
    const present = existsSync(root + rel);
    it.skipIf(!present)(`${rel}${present ? '' : ' (SKIPPED: missing; see scripts/stress-media.sh)'}`, async () => {
      expect(await verdicts(root + rel)).toEqual({ header: codes, ffprobe: codes });
    });
  }
});
