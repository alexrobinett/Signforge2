// checkVideo against clips encoded by ffmpeg (test/fixtures/make.sh). Where ffprobe is installed,
// what the header reader finds is compared with what ffprobe reports for the same file.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blobReader, checkVideo, type ReadRange, type VideoProblemCode } from '../src';

const dir = fileURLToPath(new URL('fixtures/', import.meta.url));
const bytes = (name: string) => new Uint8Array(readFileSync(dir + name));

/** A reader over the bytes that records each read. */
function reader(b: Uint8Array) {
  const reads: { offset: number; length: number }[] = [];
  const read: ReadRange = async (offset, length) => {
    reads.push({ offset, length });
    return b.subarray(offset, offset + length);
  };
  return { read, reads };
}

const check = (name: string) => {
  const b = bytes(name);
  return checkVideo(reader(b).read, b.length);
};

const EXPECTED: Record<string, VideoProblemCode[]> = {
  'high.mp4': [],
  'main-moov-at-end.mp4': [],
  'baseline.mp4': [],
  'portrait-29.97.mp4': [],
  'high10.mp4': ['profile', 'pixel-format'],
  'high422.mp4': ['profile', 'pixel-format'],
  'fps60.mp4': ['fps'],
  'interlaced.mp4': ['interlaced'],
  '1440p.mp4': ['level', 'size'],
  'level51.mp4': ['level'],
  'bitrate.mp4': ['bitrate'],
  'hevc.mp4': ['codec'],
  'fragmented.mp4': ['unreadable'],
  'audio-only.mp4': ['unreadable'],
  'vp9.webm': ['unreadable'],
};

describe('checkVideo', () => {
  it('has an expectation for every fixture', () => {
    expect(
      readdirSync(dir)
        .filter((f) => !f.endsWith('.sh'))
        .sort(),
    ).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, codes] of Object.entries(EXPECTED)) {
    it(`${name}: ${codes.length ? codes.join(', ') : 'accepted'}`, async () => {
      const r = await check(name);
      expect(r.problems.map((p) => p.code)).toEqual(codes);
    });
  }

  it('reads a High profile 1080p-class header: profile, level, 4:2:0, 8-bit, progressive, size, rate', async () => {
    const r = await check('high.mp4');
    expect(r.info).toMatchObject({
      codec: 'h264',
      profileIdc: 100,
      levelIdc: 41,
      chromaFormat: 1,
      bitDepth: 8,
      progressive: true,
      width: 320,
      height: 180,
      fps: 30,
      durationMs: 1000,
    });
  });

  it('says why, in words a person can act on', async () => {
    expect((await check('high10.mp4')).problems.map((p) => p.message)).toEqual([
      'H.264 profile High 10 is not one screens play (Baseline, Main, High)',
      'the video is 10-bit 4:2:0; screens need 8-bit 4:2:0 (yuv420p)',
    ]);
    expect((await check('fps60.mp4')).problems[0]!.message).toBe('60 fps is above 30');
    expect((await check('1440p.mp4')).problems[1]!.message).toBe('2560x1440 is larger than 1920x1080');
    expect((await check('vp9.webm')).problems[0]!.message).toBe('the file is WebM or Matroska, not an MP4');
    expect((await check('fragmented.mp4')).problems[0]!.message).toBe('the file is a fragmented MP4');
  });

  it('allows 29.97 fps and a portrait frame', async () => {
    const r = await check('portrait-29.97.mp4');
    expect(r.info).toMatchObject({ width: 180, height: 320 });
    expect(r.info!.fps).toBeCloseTo(29.97, 2);
  });

  it('reads only the header: one read past the box headers when the moov comes first, a jump past the mdat when it comes last', async () => {
    for (const [name, moovFirst] of [
      ['high.mp4', true],
      ['main-moov-at-end.mp4', false],
    ] as const) {
      const b = bytes(name);
      const { read, reads } = reader(b);
      await checkVideo(read, b.length);
      const total = reads.reduce((n, x) => n + Math.min(x.length, b.length - x.offset), 0);
      expect(total).toBeLessThan(b.length / 2);
      const moovAt = reads.at(-1)!.offset;
      if (moovFirst) expect(moovAt).toBeLessThan(100);
      else expect(moovAt).toBeGreaterThan(b.length / 2);
    }
  });

  it('refuses a file over the size cap without reading it', async () => {
    const { read, reads } = reader(new Uint8Array(0));
    const r = await checkVideo(read, 600_000_000);
    expect(r.problems).toEqual([{ code: 'bytes', message: 'the file is 600 MB; the most a video may be is 500 MB' }]);
    expect(reads).toEqual([]);
  });

  it('fails closed on a damaged header', async () => {
    const b = bytes('high.mp4').slice();
    // Cut the file inside its moov.
    const r = await checkVideo(reader(b.subarray(0, 900)).read, b.length);
    expect(r.problems.map((p) => p.code)).toEqual(['unreadable']);
    // Garbage where the SPS is: the bytes after "avcC" plus its header.
    const at = Buffer.from(b).indexOf('avcC') + 12;
    b.fill(0xff, at, at + 20);
    expect((await checkVideo(reader(b).read, b.length)).problems.map((p) => p.code)).toContain('unreadable');
  });

  it('reads a Blob the way the browser does', async () => {
    const b = bytes('high.mp4');
    expect((await checkVideo(blobReader(new Blob([b])), b.length)).problems).toEqual([]);
  });
});

const hasFfprobe = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfprobe)('the header reader agrees with ffprobe', () => {
  const PROFILES: Record<string, number> = { 'Constrained Baseline': 66, Baseline: 66, Main: 77, High: 100, 'High 10': 110, 'High 4:2:2': 122 };
  for (const name of Object.keys(EXPECTED).filter((n) => n.endsWith('.mp4') && !['hevc.mp4', 'audio-only.mp4', 'fragmented.mp4'].includes(n))) {
    it(name, async () => {
      const out = execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=profile,level,pix_fmt,field_order,width,height,avg_frame_rate,bit_rate',
          '-of',
          'json',
          dir + name,
        ],
        { encoding: 'utf8' },
      );
      const s = JSON.parse(out).streams[0];
      const [num, den] = s.avg_frame_rate.split('/').map(Number);
      const { info } = await check(name);
      expect(info).toMatchObject({
        profileIdc: PROFILES[s.profile],
        levelIdc: s.level,
        width: s.width,
        height: s.height,
        progressive: s.field_order === 'progressive',
      });
      expect(info!.bitDepth).toBe(s.pix_fmt.includes('10') ? 10 : 8);
      expect(info!.chromaFormat).toBe(s.pix_fmt.startsWith('yuv422') ? 2 : 1);
      expect(info!.fps).toBeCloseTo(num / den, 2);
      expect(Math.abs(info!.bitrate! - Number(s.bit_rate))).toBeLessThan(Number(s.bit_rate) * 0.01);
    });
  }
});
