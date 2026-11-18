/**
 * Read what `VIDEO_SPEC` checks from an MP4's header: the video track's sample entry, its H.264
 * sequence parameter set (SPS), and its sample table for frame rate and bit rate. Pure byte
 * parsing over a range reader, so it runs the same over a browser `File` and over R2 range reads.
 *
 * It reads the top-level box headers until it finds the `moov`, then the `moov` whole: one read
 * when the file starts with it (`-movflags +faststart`), a jump past the `mdat` when it ends with it.
 */

/** Read `length` bytes at `offset`. May return fewer only at the end of the file. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

/** What the header says. Null where it says nothing readable; the check rejects those. */
export interface VideoInfo {
  /** `h264`, or what the file is instead (`hevc`, `vp09`, `not an MP4`, ...). */
  codec: string;
  profileIdc: number | null;
  levelIdc: number | null;
  /** 0 monochrome, 1 4:2:0, 2 4:2:2, 3 4:4:4. */
  chromaFormat: number | null;
  /** The larger of the luma and chroma bit depths. */
  bitDepth: number | null;
  progressive: boolean | null;
  /** As decoded: the SPS size after cropping. */
  width: number | null;
  height: number | null;
  /** Average: frames over the track's length. */
  fps: number | null;
  /** The video track's average bits per second: its samples' bytes over its length. */
  bitrate: number | null;
  durationMs: number | null;
  /** The whole file. */
  bytes: number;
}

/** The header could not be read at all: not an MP4, damaged, or a layout this reader refuses. */
export class Mp4Error extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'Mp4Error';
  }
}

/** A `moov` is a few hundred kB even for a long video; anything near this is not a real one. */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

interface Box {
  type: string;
  /** Where the body starts and ends, in the buffer it was found in. */
  start: number;
  end: number;
}

/** The boxes inside `b` between `from` and `to`. */
function boxes(b: Uint8Array, from = 0, to = b.length): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let i = from;
  while (i + 8 <= to) {
    let size = v.getUint32(i);
    const type = ascii(b, i + 4, 4);
    let header = 8;
    if (size === 1) {
      if (i + 16 > to) throw new Mp4Error(`the ${type} box is cut short`);
      size = Number(v.getBigUint64(i + 8));
      header = 16;
    } else if (size === 0) size = to - i;
    if (size < header || i + size > to) throw new Mp4Error(`the ${type} box runs past its parent`);
    out.push({ type, start: i + header, end: i + size });
    i += size;
  }
  return out;
}

const child = (b: Uint8Array, parent: Box, type: string) => boxes(b, parent.start, parent.end).find((x) => x.type === type);

function need(b: Uint8Array, parent: Box, type: string): Box {
  const box = child(b, parent, type);
  if (!box) throw new Mp4Error(`the ${parent.type} box has no ${type}`);
  return box;
}

/** Find the top-level `moov` and read it whole. */
async function readMoov(read: ReadRange, size: number): Promise<Uint8Array> {
  let offset = 0;
  let first = true;
  while (offset + 8 <= size) {
    const head = await read(offset, 16);
    if (head.length < 8) throw new Mp4Error('the file ends inside a box header');
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const type = ascii(head, 4, 4);
    if (first && type !== 'ftyp') throw new Mp4Error(`the file is ${sniff(head)}`);
    first = false;
    let boxSize = v.getUint32(0);
    let header = 8;
    if (boxSize === 1) {
      if (head.length < 16) throw new Mp4Error('the file ends inside a box header');
      boxSize = Number(v.getBigUint64(8));
      header = 16;
    } else if (boxSize === 0) boxSize = size - offset;
    if (boxSize < header) throw new Mp4Error(`the ${type} box has a size smaller than its header`);
    if (type === 'moov') {
      if (boxSize > MAX_MOOV_BYTES) throw new Mp4Error(`the moov box is ${boxSize} bytes, more than a header can be`);
      if (offset + boxSize > size) throw new Mp4Error('the moov box runs past the end of the file');
      const moov = await read(offset, boxSize);
      if (moov.length < boxSize) throw new Mp4Error('the moov box runs past the end of the file');
      return moov;
    }
    offset += boxSize;
  }
  throw new Mp4Error('the file has no moov box');
}

/** What a file that is not an MP4 probably is, for the rejection. */
function sniff(head: Uint8Array): string {
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'WebM or Matroska, not an MP4';
  if (ascii(head, 0, 4) === 'RIFF') return 'AVI, not an MP4';
  return 'not an MP4 (it has no ftyp box)';
}

/** Reads bits of an RBSP: the NAL unit payload with emulation-prevention bytes removed. */
class Bits {
  private bit = 0;
  constructor(private readonly b: Uint8Array) {}
  u(n: number): number {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const byte = this.b[this.bit >> 3];
      if (byte === undefined) throw new Mp4Error('the SPS is cut short');
      v = v * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return v;
  }
  /** Exp-Golomb, unsigned. */
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) if (++zeros > 31) throw new Mp4Error('the SPS has a malformed number');
    return 2 ** zeros - 1 + this.u(zeros);
  }
  /** Exp-Golomb, signed. */
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

function rbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]!);
  }
  return new Uint8Array(out);
}

// Profiles whose SPS carries chroma format and bit depth (H.264 7.3.2.1.1).
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

interface Sps {
  profileIdc: number;
  levelIdc: number;
  chromaFormat: number;
  bitDepth: number;
  progressive: boolean;
  width: number;
  height: number;
}

/** H.264 7.3.2.1.1, as far as frame cropping. */
function parseSps(nal: Uint8Array): Sps {
  if ((nal[0]! & 0x1f) !== 7) throw new Mp4Error('the avcC box holds no SPS');
  const r = new Bits(rbsp(nal.subarray(1)));
  const profileIdc = r.u(8);
  r.u(8); // constraint flags
  const levelIdc = r.u(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormat = 1;
  let separatePlanes = 0;
  let bitDepth = 8;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) separatePlanes = r.u(1);
    bitDepth = 8 + Math.max(r.ue(), r.ue());
    r.u(1); // qpprime_y_zero_transform_bypass_flag
    if (r.u(1)) {
      for (let i = 0; i < (chromaFormat === 3 ? 12 : 8); i++) {
        if (!r.u(1)) continue;
        // scaling_list(): read only to get past it.
        let last = 8;
        let next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u(1); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
  r.u(1); // direct_8x8_inference_flag
  let crop = [0, 0, 0, 0];
  if (r.u(1)) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  // Crop units, H.264 7.4.2.1.1: chroma subsampling, and two rows per unit when fields are allowed.
  const mono = chromaFormat === 0 || separatePlanes === 1;
  const cropX = mono ? 1 : chromaFormat === 3 ? 1 : 2;
  const cropY = (mono ? 1 : chromaFormat === 1 ? 2 : 1) * (2 - frameMbsOnly);
  const [left, right, top, bottom] = crop;
  return {
    profileIdc,
    levelIdc,
    chromaFormat,
    bitDepth,
    progressive: frameMbsOnly === 1,
    width: widthMbs * 16 - cropX * (left! + right!),
    height: (2 - frameMbsOnly) * heightMapUnits * 16 - cropY * (top! + bottom!),
  };
}

const CODECS: Record<string, string> = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', vp09: 'vp9', av01: 'av1', mp4v: 'mpeg4' };

/** The video track's info. Throws `Mp4Error` when the header cannot be read. */
export async function readMp4(read: ReadRange, size: number): Promise<VideoInfo> {
  const b = await readMoov(read, size);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const moov = boxes(b)[0]!;
  // Its samples are listed in moof boxes through the file, not in the moov.
  if (child(b, moov, 'mvex')) throw new Mp4Error('the file is a fragmented MP4');
  const videoTracks = boxes(b, moov.start, moov.end)
    .filter((t) => t.type === 'trak')
    .filter((t) => {
      const hdlr = need(b, need(b, t, 'mdia'), 'hdlr');
      return ascii(b, hdlr.start + 8, 4) === 'vide';
    });
  if (videoTracks.length === 0) throw new Mp4Error('the file has no video track');
  if (videoTracks.length > 1) throw new Mp4Error(`the file has ${videoTracks.length} video tracks; a screen plays one`);
  const mdia = need(b, videoTracks[0]!, 'mdia');

  const mdhd = need(b, mdia, 'mdhd');
  const version = b[mdhd.start]!;
  const timescale = v.getUint32(mdhd.start + (version === 1 ? 20 : 12));
  const duration = version === 1 ? Number(v.getBigUint64(mdhd.start + 24)) : v.getUint32(mdhd.start + 16);

  const stbl = need(b, need(b, mdia, 'minf'), 'stbl');
  const stsd = need(b, stbl, 'stsd');
  const entries = v.getUint32(stsd.start + 4);
  if (entries !== 1) throw new Mp4Error(`the video track has ${entries} sample descriptions; a screen plays one`);
  const entry = boxes(b, stsd.start + 8, stsd.end)[0];
  if (!entry) throw new Mp4Error('the video track has no sample description');
  const codec = CODECS[entry.type] ?? entry.type;

  // Frames and bytes, from the time-to-sample and sample-size tables.
  const stts = need(b, stbl, 'stts');
  let frames = 0;
  let ticks = 0;
  for (let i = 0, n = v.getUint32(stts.start + 4); i < n; i++) {
    const count = v.getUint32(stts.start + 8 + i * 8);
    frames += count;
    ticks += count * v.getUint32(stts.start + 12 + i * 8);
  }
  const stsz = need(b, stbl, 'stsz');
  const sampleSize = v.getUint32(stsz.start + 4);
  const samples = v.getUint32(stsz.start + 8);
  let sampleBytes = sampleSize * samples;
  if (sampleSize === 0) for (let i = 0; i < samples; i++) sampleBytes += v.getUint32(stsz.start + 12 + i * 4);

  const seconds = timescale > 0 ? duration / timescale : 0;
  const info: VideoInfo = {
    codec,
    profileIdc: null,
    levelIdc: null,
    chromaFormat: null,
    bitDepth: null,
    progressive: null,
    width: null,
    height: null,
    fps: frames > 0 && ticks > 0 && timescale > 0 ? (frames * timescale) / ticks : null,
    bitrate: seconds > 0 && sampleBytes > 0 ? (sampleBytes * 8) / seconds : null,
    durationMs: seconds > 0 ? Math.round(seconds * 1000) : null,
    bytes: size,
  };
  // avc3 may carry its SPS in the stream instead of the header, so only avc1's is the whole story.
  if (entry.type !== 'avc1') return info;

  // VisualSampleEntry: 78 bytes, then its boxes.
  const avcC = boxes(b, entry.start + 78, entry.end).find((x) => x.type === 'avcC');
  if (!avcC) throw new Mp4Error('the avc1 sample entry has no avcC box');
  const spsCount = b[avcC.start + 5]! & 0x1f;
  if (spsCount !== 1) throw new Mp4Error(`the avcC box has ${spsCount} SPS; a screen's check reads one`);
  const spsLength = v.getUint16(avcC.start + 6);
  if (avcC.start + 8 + spsLength > avcC.end) throw new Mp4Error('the SPS runs past its avcC box');
  return { ...info, ...parseSps(b.subarray(avcC.start + 8, avcC.start + 8 + spsLength)) };
}
