// The tenancy guard's other half: nothing outside packages/db may reach the table objects.
// Code elsewhere imports `@signforge/db` (repositories and row types) or `@signforge/db/testing`
// in tests, and nothing else from this package.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Table, is } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = resolve(PKG, '../..');
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.turbo', '.wrangler', 'vendor']);
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const ALLOWED = new Set(['@signforge/db', '@signforge/db/testing']);
const SPECIFIER = /\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

function* codeFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p !== PKG) yield* codeFiles(p);
    } else if (CODE.test(e.name)) yield p;
  }
}

/** Imports in `source` (a file at `file`) that reach into packages/db past its public entry points. */
export function forbiddenImports(file: string, source: string): string[] {
  const bad: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = (m[1] ?? m[2] ?? m[3] ?? m[4])!;
    if (spec.startsWith('@signforge/db')) {
      if (!ALLOWED.has(spec)) bad.push(spec);
    } else if (spec.startsWith('.') || spec.startsWith('/')) {
      const target = resolve(dirname(file), spec);
      if (target === PKG || target.startsWith(PKG + sep)) bad.push(spec);
    }
  }
  return bad;
}

describe('import boundary', () => {
  it('catches the ways in', () => {
    const f = join(ROOT, 'apps/api/src/x.ts');
    expect(forbiddenImports(f, "import { screens } from '@signforge/db/schema';")).toEqual(['@signforge/db/schema']);
    expect(forbiddenImports(f, "import * as s from '../../../packages/db/src/schema';")).toEqual(['../../../packages/db/src/schema']);
    expect(forbiddenImports(f, "const s = await import('@signforge/db/src/schema.ts');")).toHaveLength(1);
    expect(forbiddenImports(f, "export { screens } from '@signforge/db/src/schema';")).toHaveLength(1);
    expect(forbiddenImports(f, "import { scoped } from '@signforge/db';\nimport { seedTwoOrgs } from '@signforge/db/testing';")).toEqual([]);
  });

  it('holds across the repo', () => {
    const offenders: string[] = [];
    for (const file of codeFiles(ROOT)) {
      for (const spec of forbiddenImports(file, readFileSync(file, 'utf8'))) offenders.push(`${relative(ROOT, file)}: ${spec}`);
    }
    expect(offenders).toEqual([]);
  });

  it('exports only the public entry points', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './testing']);
  });

  it('exports no table objects', async () => {
    // Imported by path so this Node-typed file does not type-check the Workers-typed source.
    for (const path of ['../../src/index.ts', '../../src/testing.ts']) {
      const mod = (await import(path)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) expect(is(value, Table), `${path}: ${name}`).toBe(false);
    }
  });
});
