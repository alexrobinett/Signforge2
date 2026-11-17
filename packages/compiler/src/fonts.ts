/**
 * The font catalogue. A brand kit names its fonts by catalogue id, `<owner>/<id>`, the way spots
 * name templates. `base` owns the curated set below: open fonts licensed under the SIL Open Font
 * Licence 1.1, which allows embedding and redistribution with the screens' content and needs no
 * notice on screen. Org-owned uploads (M3-38 leaves them out) will use the org id as owner, so
 * stored ids never change shape.
 *
 * Files: each family is served as WOFF2, at most `MAX_FONT_FAMILY_BYTES` for all its files, as
 * base blobs. Their bytes are not in the repo yet, so every entry's `files` is empty and a kit's
 * font is left out of the manifest until they are: a template then draws with its own font.
 * Adding them is filling `files` (sha256 and size per weight); nothing else changes.
 */
import type { Sha256 } from '@signforge/contract';

/** Brand fonts are decoded at `prepare` on the Pi; this keeps one family inside its budget (docs/template-spec.md). */
export const MAX_FONT_FAMILY_BYTES = 150_000;

export interface CatalogueFont {
  /** `<owner>/<id>`, as `BrandFont.id` carries it. */
  id: string;
  /** The CSS family name. */
  family: string;
  /** What it is good for on a screen: headlines (`display`), running text (`body`), or both. */
  roles: ('display' | 'body')[];
  /** The weights the curated files cover. */
  weights: number[];
  licence: { spdx: 'OFL-1.1'; copyright: string; source: string };
  /** WOFF2 files. Empty until the bytes are added (see above). */
  files: { weight: number; style: 'normal' | 'italic'; file: Sha256; size: number }[];
}

const ofl = (copyright: string, source: string) => ({ spdx: 'OFL-1.1' as const, copyright, source });

export const FONTS: readonly CatalogueFont[] = [
  {
    id: 'base/inter',
    family: 'Inter',
    roles: ['display', 'body'],
    weights: [400, 600, 800],
    licence: ofl('Copyright 2016 The Inter Project Authors', 'https://github.com/rsms/inter'),
    files: [],
  },
  {
    id: 'base/atkinson-hyperlegible',
    family: 'Atkinson Hyperlegible',
    roles: ['body'],
    weights: [400, 700],
    licence: ofl('Copyright 2020 Braille Institute of America, Inc.', 'https://github.com/googlefonts/atkinson-hyperlegible'),
    files: [],
  },
  {
    id: 'base/source-sans-3',
    family: 'Source Sans 3',
    roles: ['body'],
    weights: [400, 600, 700],
    licence: ofl('Copyright 2010-2020 Adobe (http://www.adobe.com/), with Reserved Font Name Source', 'https://github.com/adobe-fonts/source-sans'),
    files: [],
  },
  {
    id: 'base/archivo',
    family: 'Archivo',
    roles: ['display', 'body'],
    weights: [400, 600, 800],
    licence: ofl('Copyright 2019 The Archivo Project Authors', 'https://github.com/Omnibus-Type/Archivo'),
    files: [],
  },
  {
    id: 'base/montserrat',
    family: 'Montserrat',
    roles: ['display', 'body'],
    weights: [400, 600, 800],
    licence: ofl('Copyright 2011 The Montserrat Project Authors', 'https://github.com/JulietaUla/Montserrat'),
    files: [],
  },
  {
    id: 'base/oswald',
    family: 'Oswald',
    roles: ['display'],
    weights: [500, 700],
    licence: ofl('Copyright 2016 The Oswald Project Authors', 'https://github.com/googlefonts/OswaldFont'),
    files: [],
  },
  {
    id: 'base/bebas-neue',
    family: 'Bebas Neue',
    roles: ['display'],
    weights: [400],
    licence: ofl('Copyright 2010 Dharma Type', 'https://github.com/dharmatype/Bebas-Neue'),
    files: [],
  },
  {
    id: 'base/playfair-display',
    family: 'Playfair Display',
    roles: ['display'],
    weights: [400, 700],
    licence: ofl('Copyright 2017 The Playfair Display Project Authors', 'https://github.com/clauseggers/Playfair-Display'),
    files: [],
  },
];

const byId = new Map(FONTS.map((f) => [f.id, f]));

/** A catalogue font by id. Only `base` fonts exist for now. */
export const fontById = (id: string): CatalogueFont | undefined => byId.get(id);
