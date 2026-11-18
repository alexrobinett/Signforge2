# Brand fonts

The curated font catalogue (`base` owner) that brand kits choose from. The catalogue itself is
`packages/compiler/src/fonts.ts`; a test there checks every file here against its recorded hash
and size, and each family against the 150 kB budget (`MAX_FONT_FAMILY_BYTES`).

Each directory holds one family: a WOFF2 per weight, named `<weight>-<style>.woff2`, and the
family's licence, `OFL.txt` (SIL Open Font License 1.1). All files are the **latin** subset.
`sf fonts push` uploads them to R2 as base blobs (`sys/b/<sha256>`).

Source: the `@fontsource/<family>` npm packages (`files/<family>-latin-<weight>-normal.woff2`),
which are built from Google Fonts' copies of each project's release. Licence texts come from
the same packages, except Source Sans 3, whose package carries only "Google Inc."; its
`OFL.txt` is Adobe's `LICENSE.md` from github.com/adobe-fonts/source-sans.

| Family | Package | Weights | Bytes per file | Family total |
| --- | --- | --- | --- | --- |
| Inter | @fontsource/inter 5.3.0 | 400, 600, 800 | 23,664 / 24,452 / 24,400 | 72,516 |
| Atkinson Hyperlegible | @fontsource/atkinson-hyperlegible 5.3.0 | 400, 700 | 17,208 / 17,524 | 34,732 |
| Archivo | @fontsource/archivo 5.3.0 | 400, 600, 800 | 14,700 / 13,820 / 14,416 | 42,936 |
| Montserrat | @fontsource/montserrat 5.3.0 | 400, 600, 800 | 18,780 / 18,688 / 19,012 | 56,480 |
| Oswald | @fontsource/oswald 5.3.0 | 500, 700 | 12,704 / 12,672 | 25,376 |
| Bebas Neue | @fontsource/bebas-neue 5.3.0 | 400 | 13,768 | 13,768 |

## Reserved Font Names

Decided 2026-11-17: the catalogue has no font with a Reserved Font Name. The OFL counts a subset
as a Modified Version, which may not carry a reserved name, and every family here must be a
latin subset to fit the 150 kB budget (the unsubset files of Source Sans 3 and Playfair Display
are several times larger). So Source Sans 3 and Playfair Display were dropped. Check a new
family's `OFL.txt` for a "Reserved Font Name" line before adding it.

## Adding a family or a weight

Put the latin WOFF2 here, add its `files` entry (sha256 and size) and weight to the catalogue,
keep the family under 150 kB, ship its `OFL.txt`, and add a row above.
