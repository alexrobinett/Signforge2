/*!
 * The QR encoder bundled here is uqr 0.1.3 (https://github.com/unjs/uqr), under its MIT licence,
 * kept in every template bundle that draws a QR code, as the licence requires:
 *
 * MIT License
 *
 * Copyright (c) Project Nayuki
 * Copyright (c) 2023 Anthony Fu <https://github.com/antfu>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
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
