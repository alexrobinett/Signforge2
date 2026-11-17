/**
 * The font catalogue. A brand kit names its fonts by catalogue id, `<owner>/<id>`, the way spots
 * name templates. `base` owns the curated set below: open fonts licensed under the SIL Open Font
 * Licence 1.1, which allows embedding and redistribution with the screens' content and needs no
 * notice on screen. Org-owned uploads (M3-38 leaves them out) will use the org id as owner, so
 * stored ids never change shape.
 *
 * Files: each family is served as WOFF2, latin subset, at most `MAX_FONT_FAMILY_BYTES` for all its
 * files. The bytes and each font's licence are in the repo's `fonts/<id>/` (`fontFilePath`; sources
 * and sizes in fonts/README.md). `sf fonts push` uploads them as base blobs (`sys/b/<sha256>`),
 * where the device and preview blob routes serve them to any org (`isCatalogueFontFile`).
 * Adding a weight is adding its file there and its entry here; a test checks the two agree.
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
  /** WOFF2 files, one per weight. */
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
    files: [
      { weight: 400, style: 'normal', file: '8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc', size: 23664 },
      { weight: 600, style: 'normal', file: 'f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a', size: 24452 },
      { weight: 800, style: 'normal', file: 'a7d0a50f15d389cad679238466bdb5fc9787aa0715719064ce25abaff042820d', size: 24400 },
    ],
  },
  {
    id: 'base/atkinson-hyperlegible',
    family: 'Atkinson Hyperlegible',
    roles: ['body'],
    weights: [400, 700],
    licence: ofl('Copyright 2020 Braille Institute of America, Inc.', 'https://github.com/googlefonts/atkinson-hyperlegible'),
    files: [
      { weight: 400, style: 'normal', file: 'd64ba838ef5472bba248620ec4fd8b5aa7cf0db2908e0bb230600caf279ba7bc', size: 17208 },
      { weight: 700, style: 'normal', file: '140e2bd25a7315c8a062508391426b0d8c3297400c947b8d847be28f73a199f0', size: 17524 },
    ],
  },
  {
    id: 'base/source-sans-3',
    family: 'Source Sans 3',
    roles: ['body'],
    weights: [400, 600, 700],
    licence: ofl("Copyright 2010-2024 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'", 'https://github.com/adobe-fonts/source-sans'),
    files: [
      { weight: 400, style: 'normal', file: '0f73f35e08cde0a2f10c109c6e01d71459d97e4099ecd9a50f1b6c0209e4de2b', size: 15696 },
      { weight: 600, style: 'normal', file: '14527d193b0e30bc32ef931549a246cdfd286573bb12869b7e052b8101a39d38', size: 15668 },
      { weight: 700, style: 'normal', file: 'ae35266f2ab0d5314ff9a04127931eb26c793e4f1269bb240046d4d2db4b7bb1', size: 15596 },
    ],
  },
  {
    id: 'base/archivo',
    family: 'Archivo',
    roles: ['display', 'body'],
    weights: [400, 600, 800],
    licence: ofl('Copyright 2020 The Archivo Project Authors', 'https://github.com/Omnibus-Type/Archivo'),
    files: [
      { weight: 400, style: 'normal', file: '07f9160163da2ec0f6376ef9d27a2bb8163f98019ba798da4baafb154e30056e', size: 14700 },
      { weight: 600, style: 'normal', file: 'd9e8c29fdd348edde2a4f9aae438e569dd165bbbdebda78495824a2d9aaa67e8', size: 13820 },
      { weight: 800, style: 'normal', file: 'c26cda2400b374eb1adb6e0973c86f455e2df17ca57c6755eb37d7bde47663fb', size: 14416 },
    ],
  },
  {
    id: 'base/montserrat',
    family: 'Montserrat',
    roles: ['display', 'body'],
    weights: [400, 600, 800],
    licence: ofl('Copyright 2011 The Montserrat Project Authors', 'https://github.com/JulietaUla/Montserrat'),
    files: [
      { weight: 400, style: 'normal', file: 'e66bcd2761ab6924b25ce70dafe10e57a39193c4fea1516730bd9cb5240af6c8', size: 18780 },
      { weight: 600, style: 'normal', file: 'd857325c360f7128b347ca924c1974967aaa886ba47dad22e4042d6c38b26a83', size: 18688 },
      { weight: 800, style: 'normal', file: 'ba826fb84c2e961578adf3a08b5778b87905d4443445d1d56d84f9f157d5ea4b', size: 19012 },
    ],
  },
  {
    id: 'base/oswald',
    family: 'Oswald',
    roles: ['display'],
    weights: [500, 700],
    licence: ofl('Copyright 2016 The Oswald Project Authors', 'https://github.com/googlefonts/OswaldFont'),
    files: [
      { weight: 500, style: 'normal', file: '541b12882301dc44b73eaaed9e230709df1d299379c3594695870fc2f9e3ff0a', size: 12704 },
      { weight: 700, style: 'normal', file: 'aae665c75af89ea7cb7d8ccc8b0911ea72267442ebcd84f6e3efa041ad3b3c16', size: 12672 },
    ],
  },
  {
    id: 'base/bebas-neue',
    family: 'Bebas Neue',
    roles: ['display'],
    weights: [400],
    licence: ofl('Copyright 2019 The Bebas Neue Project Authors', 'https://github.com/dharmatype/Bebas-Neue'),
    files: [
      { weight: 400, style: 'normal', file: 'a7c90c89240c134f7fdd33d40c000ec90b79d675ea53e8cc5a6d423c073de412', size: 13768 },
    ],
  },
  {
    id: 'base/playfair-display',
    family: 'Playfair Display',
    roles: ['display'],
    weights: [400, 700],
    licence: ofl('Copyright 2017 The Playfair Display Project Authors', 'https://github.com/clauseggers/Playfair-Display'),
    files: [
      { weight: 400, style: 'normal', file: '1fe9ad5d8b2ebd8ecb8fbd05bed1e3fdfa52dae3f1a04e1c219918442fe9394d', size: 21856 },
      { weight: 700, style: 'normal', file: '28453852ea165c47b5a941be00e418402e1407002ed87507f062a1e316328fe6', size: 23224 },
    ],
  },
];

const byId = new Map(FONTS.map((f) => [f.id, f]));
const fileShas = new Set(FONTS.flatMap((f) => f.files.map((x) => x.file)));

/** Whether a hash is one of the catalogue's font files: public bytes, kept once for every org under `sys/b/`. */
export const isCatalogueFontFile = (sha256: string): boolean => fileShas.has(sha256);

/** Where a catalogue file lives in the repo, from its root: `fonts/inter/400-normal.woff2`. */
export const fontFilePath = (font: Pick<CatalogueFont, 'id'>, file: Pick<CatalogueFont['files'][number], 'weight' | 'style'>): string =>
  `fonts/${font.id.slice(font.id.indexOf('/') + 1)}/${file.weight}-${file.style}.woff2`;

/** A catalogue font by id. Only `base` fonts exist for now. */
export const fontById = (id: string): CatalogueFont | undefined => byId.get(id);
