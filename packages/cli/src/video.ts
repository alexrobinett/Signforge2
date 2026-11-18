/**
 * `sf build`'s video check: ffprobe reads the file, and `@signforge/media-check`'s
 * `videoProblems` applies the same rule the CMS and the server apply to an upload.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { type VideoInfo, videoProblems } from '@signforge/media-check';

interface Probe {
  streams: {
    codec_name: string;
    profile?: string;
    pix_fmt?: string;
    level?: number;
    field_order?: string;
    width?: number;
    height?: number;
    avg_frame_rate: string;
    r_frame_rate: string;
    bit_rate?: string;
    duration?: string;
  }[];
  format?: { bit_rate?: string };
}

// ffprobe's names for H.264 profile_idc values.
const PROFILE_IDCS: Record<string, number> = {
  'Constrained Baseline': 66,
  Baseline: 66,
  Main: 77,
  Extended: 88,
  High: 100,
  'High 10': 110,
  'High 10 Intra': 110,
  'High 4:2:2': 122,
  'High 4:2:2 Intra': 122,
  'High 4:4:4 Predictive': 244,
  'High 4:4:4 Intra': 244,
  'CAVLC 4:4:4': 44,
};
const CHROMA: Record<string, number> = { '420': 1, '422': 2, '444': 3 };

/** The file's video stream as `VideoInfo`, from ffprobe; a list of problems if ffprobe cannot read it; null if ffprobe is not installed. */
export function probeVideo(path: string): VideoInfo | string[] | null {
  let out: string;
  try {
    out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,profile,pix_fmt,level,field_order,width,height,avg_frame_rate,r_frame_rate,bit_rate,duration:format=bit_rate',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err);
    return [`ffprobe could not read the file: ${stderr.trim().split('\n')[0]}`];
  }
  const probe: Probe = JSON.parse(out);
  const v = probe.streams[0];
  if (!v) return ['no video stream'];
  const rate = (r: string) => {
    const [num, den] = r.split('/').map(Number);
    return den ? (num ?? 0) / den : 0;
  };
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate);
  // The stream's own bit rate when the container records it, the whole file's otherwise.
  const bitrate = Number(v.bit_rate) || Number(probe.format?.bit_rate);
  const pix = /^yuvj?(420|422|444)p(\d+)?(le|be)?$/.exec(v.pix_fmt ?? '');
  const seconds = Number(v.duration);
  return {
    codec: v.codec_name,
    profileIdc: PROFILE_IDCS[v.profile ?? ''] ?? null,
    levelIdc: v.level !== undefined && v.level > 0 ? v.level : null,
    chromaFormat: pix ? (CHROMA[pix[1]!] ?? null) : null,
    bitDepth: pix ? Number(pix[2] ?? 8) : null,
    progressive: v.field_order === 'progressive' ? true : v.field_order && v.field_order !== 'unknown' ? false : null,
    width: v.width ?? null,
    height: v.height ?? null,
    fps: fps > 0 ? fps : null,
    bitrate: bitrate > 0 ? bitrate : null,
    durationMs: seconds > 0 ? Math.round(seconds * 1000) : null,
    bytes: statSync(path).size,
  };
}

/** Problems with the video at `path`; null if ffprobe is not installed, so it was not checked. */
export function checkVideoFile(path: string): string[] | null {
  const info = probeVideo(path);
  if (info === null || Array.isArray(info)) return info;
  return videoProblems(info).map((p) => p.message);
}
