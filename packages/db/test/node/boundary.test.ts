// The tenancy guard's other half: nothing outside packages/db may reach the table objects.
// Code elsewhere imports `@signforge/db` (repositories and row types), and nothing else from this
// package, except that tests in a package's own test/ or e2e/ directory (and the local dev-screen
// script) may import `@signforge/db/testing`, whose direct writes production code must never reach.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Table, is } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = resolve(PKG, '../..');
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.turbo', '.wrangler', 'vendor']);
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TESTING = '@signforge/db/testing';

/** A workspace package's own `test` or `e2e` directory (pnpm-workspace.yaml), not such a folder deeper in its source. */
const TEST_DIR = /^(?:apps|packages|templates)\/[^/]+\/(?:test|e2e)\//;

/** Whether `file` may import `@signforge/db/testing`: a test, a test's harness or an e2e spec, or the local dev-screen script. */
function mayUseTesting(file: string): boolean {
  const path = relative(ROOT, file).split(sep).join('/');
  return TEST_DIR.test(path) || path === 'apps/api/scripts/dev-screen.ts';
}
const SPECIFIER =
  /\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

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
function forbiddenImports(file: string, source: string): string[] {
  const bad: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = (m[1] ?? m[2] ?? m[3] ?? m[4])!;
    if (spec.startsWith('@signforge/db')) {
      if (spec === TESTING ? !mayUseTesting(file) : spec !== '@signforge/db') bad.push(spec);
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
    expect(forbiddenImports(f, "import { scoped } from '@signforge/db';")).toEqual([]);
  });

  it('keeps the testing adapter out of production code', () => {
    const testing = "import { testScope } from '@signforge/db/testing';";
    for (const prod of [
      'apps/api/src/x.ts',
      'packages/tools/src/x.ts',
      'apps/cms/src/lib/x.ts',
      'apps/api/scripts/other.ts',
      // A `test` or `e2e` folder inside a package's source is still production code.
      'apps/api/src/test/x.ts',
      'packages/tools/src/e2e/x.ts',
      'test/x.ts',
    ])
      expect(forbiddenImports(join(ROOT, prod), testing), prod).toEqual([TESTING]);
    expect(forbiddenImports(join(ROOT, 'apps/api/src/x.ts'), "const t = await import('@signforge/db/testing');")).toEqual([TESTING]);
    for (const allowed of [
      'apps/api/test/x.test.ts',
      'packages/tools/test/harness-worker.ts',
      'packages/db/test/node/x.test.ts',
      'apps/cms/e2e/helpers.ts',
      'apps/api/scripts/dev-screen.ts',
    ])
      expect(forbiddenImports(join(ROOT, allowed), testing), allowed).toEqual([]);
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

describe('guarded fields', () => {
  // `scoped` and `platform` must drop the same fields from a caller's values: one `strip`.
  it('are stripped by one function, in src/writes.ts', () => {
    const defining = readdirSync(join(PKG, 'src')).filter((f) => /\bfunction strip\b/.test(readFileSync(join(PKG, 'src', f), 'utf8')));
    expect(defining).toEqual(['writes.ts']);
  });
});

describe('tenant writes', () => {
  // Pairing used to insert the screen's credential with raw SQL in src/pairing.ts (review fix 8).
  it('are written in scoped.ts, never in raw SQL elsewhere in the package', () => {
    const TENANT_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"]?(?!pairing_codes\b|platform_audit_log\b)[a-z_]+/;
    const outside = readdirSync(join(PKG, 'src')).filter(
      (f) => !['scoped.ts', 'schema.ts'].includes(f) && TENANT_WRITE.test(readFileSync(join(PKG, 'src', f), 'utf8')),
    );
    expect(outside).toEqual([]);
  });
});
