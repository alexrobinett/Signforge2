/**
 * `@signforge/media-check`: is this video one a screen plays well? See README.md.
 *
 * `checkVideo` reads an MP4's header through a range reader and checks it against the contract's
 * `VIDEO_SPEC`. The CMS runs it on the file before upload, `finalize_video_upload` over R2 range
 * reads after. `videoProblems` is the rule alone: `sf build` feeds it what ffprobe reports.
 */
import { VIDEO_SPEC } from '@signforge/contract';
import { Mp4Error, type ReadRange, readMp4, type VideoInfo } from './mp4';

export type { ReadRange, VideoInfo } from './mp4';

export type VideoProblemCode = 'unreadable' | 'codec' | 'profile' | 'level' | 'pixel-format' | 'interlaced' | 'size' | 'fps' | 'bitrate' | 'bytes';
export interface VideoProblem {
  code: VideoProblemCode;
  message: string;
}

/** How to make a file that passes, shown with every rejection. */
export const EXPORT_ADVICE =
  'Export it again as an MP4 with H.264, High profile at level 4.1, 8-bit 4:2:0 colour, progressive, at most 1920x1080 (1080x1920 for portrait), 30 fps and 10 Mbit/s. ' +
  'In HandBrake, the "Fast 1080p30" preset with "Web Optimized" ticked does this. ' +
  'With ffmpeg: ffmpeg -i input.mov -vf "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p" ' +
  '-c:v libx264 -profile:v high -level 4.1 -b:v 8M -maxrate 10M -bufsize 16M -movflags +faststart -an output.mp4 ' +
  '(for portrait video, scale=1080:1920).';

const PROFILE_NAMES: Record<number, string> = {
  66: 'Baseline',
  77: 'Main',
  88: 'Extended',
  100: 'High',
  110: 'High 10',
  122: 'High 4:2:2',
  244: 'High 4:4:4 Predictive',
  44: 'CAVLC 4:4:4 Intra',
};
const CHROMA_NAMES = ['monochrome', '4:2:0', '4:2:2', '4:4:4'];
const profileName = (idc: number) => PROFILE_NAMES[idc] ?? `profile_idc ${idc}`;
const allowed = (list: readonly number[], x: number) => list.includes(x);
const tooBig = (bytes: number): VideoProblem => ({
  code: 'bytes',
  message: `the file is ${(bytes / 1e6).toFixed(0)} MB; the most a video may be is ${VIDEO_SPEC.maxBytes / 1e6} MB`,
});

/** Why this video may not ship; empty when it may. A value the header did not give is a problem. */
export function videoProblems(info: VideoInfo): VideoProblem[] {
  const out: VideoProblem[] = [];
  const add = (code: VideoProblemCode, message: string) => out.push({ code, message });
  const unread = (what: string) => add('unreadable', `the ${what} could not be read from the file`);
  const s = VIDEO_SPEC;

  if (info.bytes > s.maxBytes) out.push(tooBig(info.bytes));
  if (info.codec !== s.codec) {
    add('codec', `the video is ${info.codec}; screens play H.264 only`);
    return out;
  }
  if (info.profileIdc === null) unread('H.264 profile');
  else if (!allowed(s.profileIdcs, info.profileIdc))
    add('profile', `H.264 profile ${profileName(info.profileIdc)} is not one screens play (${s.profileIdcs.map(profileName).join(', ')})`);
  if (info.levelIdc === null) unread('H.264 level');
  else if (info.levelIdc > s.maxLevel) add('level', `H.264 level ${info.levelIdc / 10} is above ${s.maxLevel / 10}`);
  if (info.chromaFormat === null || info.bitDepth === null) unread('pixel format');
  else if (info.chromaFormat !== s.chromaFormat || info.bitDepth !== s.bitDepth)
    add('pixel-format', `the video is ${info.bitDepth}-bit ${CHROMA_NAMES[info.chromaFormat] ?? 'colour'}; screens need 8-bit 4:2:0 (yuv420p)`);
  if (info.progressive === null) unread('scan type');
  else if (!info.progressive) add('interlaced', 'the video is interlaced; screens need progressive');
  if (info.width === null || info.height === null) unread('frame size');
  else if (Math.max(info.width, info.height) > s.maxWidth || Math.min(info.width, info.height) > s.maxHeight)
    add('size', `${info.width}x${info.height} is larger than ${s.maxWidth}x${s.maxHeight}`);
  if (info.fps === null) unread('frame rate');
  else if (info.fps > s.maxFps + 0.5) add('fps', `${info.fps.toFixed(info.fps % 1 ? 2 : 0)} fps is above ${s.maxFps}`);
  if (info.bitrate === null) unread('bit rate');
  else if (info.bitrate > s.maxBitrate) add('bitrate', `${(info.bitrate / 1e6).toFixed(1)} Mbit/s is above ${s.maxBitrate / 1e6}`);
  return out;
}

export interface VideoCheck {
  /** Null when the header could not be read at all. */
  info: VideoInfo | null;
  problems: VideoProblem[];
}

/** Read an MP4's header through `read` and check it against `VIDEO_SPEC`. */
export async function checkVideo(read: ReadRange, size: number): Promise<VideoCheck> {
  if (size > VIDEO_SPEC.maxBytes) {
    // Not worth reading: it fails anyway, and says why without the header.
    return { info: null, problems: [tooBig(size)] };
  }
  let info: VideoInfo;
  try {
    info = await readMp4(read, size);
  } catch (e) {
    if (!(e instanceof Mp4Error)) throw e;
    return { info: null, problems: [{ code: 'unreadable', message: e.message }] };
  }
  return { info, problems: videoProblems(info) };
}

/** A range reader over a `Blob` (a browser `File`). */
export const blobReader =
  (blob: Blob): ReadRange =>
  async (offset, length) =>
    new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
