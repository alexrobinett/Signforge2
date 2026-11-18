import { defineTemplate } from '@signforge/template-sdk';

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
    const night = Number(data.isDay) === 0;
    const stage = document.getElementById('stage')!;
    stage.classList.add(condition, night ? 'night' : 'day');
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
    // Rain and snow are decoration: if drawing them fails, show the forecast without them.
    return precipitation(condition, viewport).catch((err) => console.warn('[weather] no precipitation', err));
  },
});

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
