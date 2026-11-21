import { encode } from 'uqr';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * `text` (a `url` field's value) as a QR code: an SVG tile that fills its box, dark modules on
 * white whatever the brand kit, since readers need dark on light and real contrast, with the
 * four-module quiet zone they need around it. Error correction M, which still reads with 15% of
 * the code lost to glare or a scratch on the panel. Name it with `label` for screen readers.
 */
export function qrSvg(text: string, label: string): SVGSVGElement {
  const { size, data } = encode(text, { ecc: 'M', border: 4 });
  // One rectangle per run of dark modules in a row: far fewer subpaths than one per module.
  let d = '';
  data.forEach((row, y) => {
    for (let x = 0; x < size; x++) {
      if (!row[x]) continue;
      const start = x;
      while (row[x + 1]) x++;
      const run = x - start + 1;
      d += `M${start} ${y}h${run}v1h-${run}z`;
    }
  });
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const tile = document.createElementNS(SVG, 'rect');
  tile.setAttribute('width', String(size));
  tile.setAttribute('height', String(size));
  tile.setAttribute('fill', '#ffffff');
  const modules = document.createElementNS(SVG, 'path');
  modules.setAttribute('d', d);
  modules.setAttribute('fill', '#000000');
  svg.append(tile, modules);
  return svg;
}
