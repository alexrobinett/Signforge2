/**
 * Reads an MP4's header from R2 with range reads and checks it against VIDEO_SPEC, the way
 * packages/media-check will in the Worker. Only the boxes mp4box asks for are fetched, so a
 * moov at the end of a large file costs two or three small reads, not the whole body.
 */
import { createFile, MP4BoxBuffer, type Movie } from 'mp4box';

// Copied from packages/contract so the spike stands alone.
const VIDEO_SPEC = { maxLevel: 42, maxWidth: 1920, maxHeight: 1080, maxFps: 30, maxBitrate: 10_000_000 };
// H.264 profile_idc values the Pi 4 decodes: Baseline (and Constrained), Main, High. High 10 is 110.
const OK_PROFILES: Record<number, string> = { 66: 'Baseline', 77: 'Main', 100: 'High' };

export interface Mp4Report {
  ok: boolean;
  reasons: string[];
  codec?: string;
  profile?: number;
  level?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  reads: { offset: number; length: number }[];
}

export async function readMp4Header(bucket: R2Bucket, key: string, chunk = 64 * 1024): Promise<Mp4Report> {
  const head = await bucket.head(key);
  if (!head) throw new Error(`no object ${key}`);
  const size = head.size;
  const file = createFile();
  let movie: Movie | undefined;
  let error: string | undefined;
  file.onReady = (info) => (movie = info);
  file.onError = (_module, message) => (error = message);
  const reads: Mp4Report['reads'] = [];
  let offset = 0;
  while (!movie && !error && offset < size && reads.length < 16) {
    const length = Math.min(chunk, size - offset);
    const obj = await bucket.get(key, { range: { offset, length } });
    if (!obj) throw new Error('range read failed');
    reads.push({ offset, length });
    const buf = MP4BoxBuffer.fromArrayBuffer(await obj.arrayBuffer(), offset);
    // appendBuffer returns the next byte mp4box needs: past an mdat it skips straight to the moov.
    offset = file.appendBuffer(buf, offset + length >= size);
  }
  file.flush();
  if (!movie) return { ok: false, reasons: [error ?? 'no moov box found'], reads };
  const video = movie.videoTracks[0];
  if (!video) return { ok: false, reasons: ['no video track'], reads };
  const reasons: string[] = [];
  const m = /^avc1\.([0-9a-f]{2})[0-9a-f]{2}([0-9a-f]{2})$/i.exec(video.codec);
  const profile = m ? parseInt(m[1]!, 16) : undefined;
  const level = m ? parseInt(m[2]!, 16) : undefined;
  if (!m) reasons.push(`codec ${video.codec} is not H.264`);
  if (profile !== undefined && !OK_PROFILES[profile]) reasons.push(`profile ${profile} is not Baseline, Main or High (8-bit 4:2:0)`);
  if (level !== undefined && level > VIDEO_SPEC.maxLevel) reasons.push(`level ${level} > ${VIDEO_SPEC.maxLevel}`);
  const width = video.video?.width ?? video.track_width;
  const height = video.video?.height ?? video.track_height;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long > VIDEO_SPEC.maxWidth || short > VIDEO_SPEC.maxHeight) reasons.push(`${width}x${height} too large`);
  const seconds = video.samples_duration / video.timescale;
  const fps = Math.round((video.nb_samples / seconds) * 100) / 100;
  if (fps > VIDEO_SPEC.maxFps + 0.01) reasons.push(`${fps} fps > ${VIDEO_SPEC.maxFps}`);
  if (video.bitrate > VIDEO_SPEC.maxBitrate) reasons.push(`bitrate ${video.bitrate} > ${VIDEO_SPEC.maxBitrate}`);
  return { ok: reasons.length === 0, reasons, codec: video.codec, profile, level, width, height, fps, bitrate: Math.round(video.bitrate), reads };
}
