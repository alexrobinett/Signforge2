import { defineTemplate, now } from '@signforge/template-sdk';

type Condition = 'clear' | 'partly' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';

/** WMO weather interpretation codes, as used by most public forecast feeds. */
function describe(code: number): { condition: Condition; label: string } {
  if (code === 0) return { condition: 'clear', label: 'Clear' };
  if (code === 1) return { condition: 'partly', label: 'Mostly clear' };
  if (code === 2) return { condition: 'partly', label: 'Partly cloudy' };
  if (code === 3) return { condition: 'cloudy', label: 'Overcast' };
  if (code === 45 || code === 48) return { condition: 'fog', label: 'Fog' };
  if (code >= 51 && code <= 57) return { condition: 'rain', label: 'Drizzle' };
  if (code >= 61 && code <= 67) return { condition: 'rain', label: 'Rain' };
  if (code >= 71 && code <= 77) return { condition: 'snow', label: 'Snow' };
  if (code >= 80 && code <= 82) return { condition: 'rain', label: 'Showers' };
  if (code === 85 || code === 86) return { condition: 'snow', label: 'Snow showers' };
  if (code >= 95) return { condition: 'storm', label: 'Thunderstorm' };
  return { condition: 'cloudy', label: 'Cloudy' };
}

defineTemplate({
  prepare({ data, viewport }) {
    const n = (k: string) => Math.round(Number(data[k]));
    const set = (id: string, text: string) => (document.getElementById(id)!.textContent = text);
    const { condition, label } = describe(Number(data.code));
    const stage = document.getElementById('stage')!;
    // The sky for this minute: it changes at most once a minute, however often the spot plays.
    const cycle = sunCycle(Number(data.sunrise), Number(data.sunset), Math.floor(now().getTime() / 60_000) * 60_000);
    const night = cycle ? cycle.night : Number(data.isDay) === 0;
    stage.classList.add(condition, night ? 'night' : 'day');
    const day = cycle ? showCycle(stage, cycle) : undefined;
    // A light kit (light background, dark text): clouds, rain and snow are drawn in the kit's
    // background colour over a darker sky, not in its dark text colour.
    const bg = tokenRgb('--sf-bg');
    if (bg && luminance(bg) > 0.5) stage.classList.add('light-kit');
    set('temp', String(n('temp')));
    set('cond', night && condition === 'clear' ? 'Clear night' : label);
    set('high', `${n('high')}°`);
    set('low', `${n('low')}°`);
    set('wind', `${n('wind')} ${String(data.windUnit)}`);
    set('humidity', `${n('humidity')}%`);
    // From nothing at sunset to full in the dark, and back by sunrise.
    if (cycle?.night && (condition === 'clear' || condition === 'partly')) stars(0.85 * (1 - day! / skyDay(0)));
    // Rain and snow are decoration: if drawing them fails, show the forecast without them.
    return precipitation(condition, viewport).catch((err) => console.warn('[weather] no precipitation', err));
  },
});

const DAY_S = 86_400;

interface Cycle {
  night: boolean;
  /** How far the sun is across the day, or the moon across the night: 0 at its rise, 1 at its set. */
  progress: number;
  /** Minutes the sun is above the horizon (negative: below it), counted from the nearer sunrise or sunset. */
  minutes: number;
  /** Whether the nearer of the two is a sunrise. */
  morning: boolean;
  /** The moon's phase: 0 new, 0.5 full. */
  phase: number;
}

/**
 * Where the sun or moon is at `at` (ms), from a day's sunrise and sunset (Unix seconds). The times
 * repeat every 24 hours, so a snapshot from yesterday, or a night past midnight with today's times,
 * still places them, a few minutes out for each day it is old. Undefined when the feed gives no
 * usable pair: none bound (0), or a polar day or night, which has no sunrise or sunset to go by.
 */
function sunCycle(sunrise: number, sunset: number, at: number): Cycle | undefined {
  const day = sunset - sunrise;
  if (!(sunrise > 0 && day > 0 && day < DAY_S)) return undefined;
  const t = (((at / 1000 - sunrise) % DAY_S) + DAY_S) % DAY_S;
  const night = t >= day;
  const since = night ? t - day : t;
  const span = night ? DAY_S - day : day;
  return {
    night,
    progress: since / span,
    minutes: ((night ? -1 : 1) * Math.min(since, span - since)) / 60,
    morning: night ? since > span / 2 : since < span / 2,
    phase: moonPhase(at),
  };
}

/** A new moon (2000-01-06 18:14 UTC) and the mean synodic month: the phase is within a day of the real one. */
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_DAYS = 29.530588853;

function moonPhase(at: number): number {
  const months = (at - NEW_MOON_MS) / 86_400_000 / SYNODIC_DAYS;
  return months - Math.floor(months);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** How much of the day sky shows, 0 to 1, `minutes` from the nearer sunrise or sunset (negative: the sun is down). */
function skyDay(minutes: number): number {
  const x = clamp01((minutes + 40) / 90);
  return x * x * (3 - 2 * x);
}

/**
 * Set the stage's scene from the cycle, once per play: style.css places the orb on its arc from
 * `--p`, mixes the day and night skies by `--day`, and fades in the dawn or dusk glow by `--glow`.
 * Returns `--day`, 0 at night to 1 by day.
 */
function showCycle(stage: HTMLElement, c: Cycle): number {
  // Brightest just after sunset and just before sunrise; gone an hour either side.
  const glow = clamp01(1 - Math.abs(c.minutes + 5) / 70);
  stage.classList.add('arc');
  if (glow > 0) stage.classList.add(c.morning ? 'dawn' : 'dusk');
  const day = skyDay(c.minutes);
  stage.style.setProperty('--p', c.progress.toFixed(4));
  stage.style.setProperty('--day', day.toFixed(3));
  stage.style.setProperty('--glow', glow.toFixed(3));
  if (!c.night) return day;
  stage.style.setProperty('--lit', ((1 - Math.cos(2 * Math.PI * c.phase)) / 2).toFixed(3));
  document.querySelector<HTMLElement>('.orb .shade')!.style.clipPath = unlit(c.phase);
  return day;
}

/**
 * Stars, as bright as `alpha`: small fixed dots scattered over the sky, each its own brightness.
 * Dots, not CSS gradients or image tiles: on the Pi, twelve full-screen gradient layers took
 * 170-200 ms to raster as each play began, and a few dozen dots paint in next to nothing.
 */
function stars(alpha: number): void {
  const rand = rng(70);
  const sky = document.querySelector('.stars')!;
  for (let i = 0; i < 60; i++) {
    const star = document.createElement('i');
    const size = 0.24 + rand() * 0.28;
    star.style.cssText = `left:${(rand() * 100).toFixed(2)}%;top:${(rand() * 100).toFixed(2)}%;width:${size.toFixed(2)}vmin;height:${size.toFixed(2)}vmin;--a:${(100 * alpha * (0.55 + rand() * 0.45)).toFixed(1)}%`;
    sky.append(star);
  }
}

/**
 * The moon's dark part as a polygon in percent of its box: the limb on the dark side, back along
 * the terminator, a half-ellipse whose width follows the phase. Waxing, the light is on the right,
 * as seen from the northern hemisphere.
 */
function unlit(phase: number): string {
  const side = phase < 0.5 ? -1 : 1;
  const e = Math.cos(2 * Math.PI * phase);
  const steps = 32;
  const at = (i: number) => -Math.PI / 2 + (Math.PI * i) / steps;
  const pt = (x: number, a: number) => `${(50 + x * 50 * Math.cos(a)).toFixed(2)}% ${(50 + 50 * Math.sin(a)).toFixed(2)}%`;
  const limb = Array.from({ length: steps + 1 }, (_, i) => pt(side, at(i)));
  const terminator = Array.from({ length: steps + 1 }, (_, i) => pt(-side * e, at(steps - i)));
  return `polygon(${[...limb, ...terminator].join(', ')})`;
}

/** Small seeded generator, so a spot looks the same every play without using Math.random. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rain or snow, drawn once into a small seamless tile. Each layer is an element with the tile as
 * a repeating background, one tile taller than the field, sliding down by exactly one tile
 * forever. The browser rasterizes it into its usual small tiles once; after that the GPU only
 * moves it. (A whole-screen canvas does the same job but is one huge texture, which stalled.)
 * Two layers at different speeds and sizes give depth.
 */
async function precipitation(condition: Condition, viewport: { width: number; height: number }): Promise<void> {
  const kind = condition === 'snow' ? 'snow' : condition === 'rain' || condition === 'storm' ? 'rain' : undefined;
  if (!kind) return;
  const host = document.getElementById('fx')!;
  if (kind === 'rain') host.classList.add('slant');
  const heavy = condition === 'storm';
  // The size the player gives us, not innerWidth: the frame may not be laid out yet.
  const unit = Math.min(viewport.width, viewport.height) / 100;
  const tile = Math.round(unit * 40);
  // Rain and snow in the kit's text colour (its background on a light kit), against a sky mixed from the kit.
  const light = document.getElementById('stage')!.classList.contains('light-kit');
  const [cr, cg, cb] = tokenRgb(light ? '--sf-bg' : '--sf-text') ?? [220, 235, 255];
  const layers =
    kind === 'snow'
      ? [
          { count: 28, size: 0.55, alpha: 0.55, secs: 7 },
          { count: 12, size: 1.0, alpha: 0.95, secs: 4 },
        ]
      : [
          { count: heavy ? 60 : 40, size: 0.65, alpha: 0.3, secs: 0.42 },
          { count: heavy ? 26 : 16, size: 1.0, alpha: 0.55, secs: 0.3 },
        ];

  // Built in parallel, appended in order: the slow far layer must stay behind the near one, and
  // appending as each tile finishes encoding would swap them at random (PR #5, weather 1.1.1).
  const built = await Promise.all(
    layers.map(async (l, li) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = tile;
      const g = canvas.getContext('2d')!;
      const rand = rng(1234 + li * 977);
      const u = unit * l.size;
      for (let i = 0; i < l.count; i++) {
        const x = rand() * tile;
        const y = rand() * tile;
        const r = rand();
        // Draw each particle at every wrapped position so the tile repeats without seams.
        for (const ox of [-tile, 0, tile]) {
          for (const oy of [-tile, 0, tile]) {
            if (kind === 'snow') {
              const rad = (0.35 + r * 0.6) * u;
              g.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${l.alpha})`;
              g.beginPath();
              g.arc(x + ox, y + oy, rad, 0, 6.2832);
              g.fill();
            } else {
              const len = (2.5 + r * 3) * u;
              const grad = g.createLinearGradient(0, y + oy, 0, y + oy + len);
              grad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0)`);
              grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, ${l.alpha})`);
              g.strokeStyle = grad;
              g.lineWidth = Math.max(1, 0.2 * u);
              g.lineCap = 'round';
              g.beginPath();
              g.moveTo(x + ox, y + oy);
              g.lineTo(x + ox, y + oy + len);
              g.stroke();
            }
          }
        }
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`could not encode a ${tile}px tile`))), 'image/png'),
      );
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      const layer = document.createElement('div');
      layer.className = `fall ${kind}`;
      layer.style.setProperty('--tile', `${tile}px`);
      layer.style.backgroundImage = `url(${url})`;
      layer.style.animationDuration = kind === 'snow' ? `${l.secs}s, 6s` : `${l.secs}s`;
      return layer;
    }),
  );
  host.append(...built);
}

/** A token's colour as RGB, or undefined with no kit. Any CSS colour: the canvas parses it. */
function tokenRgb(name: string): [number, number, number] | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) return undefined;
  const g = document.createElement('canvas').getContext('2d')!;
  g.fillStyle = value;
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return [r!, gr!, b!];
}

/** Relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
