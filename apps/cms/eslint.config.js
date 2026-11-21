/**
 * React rules for the CMS. Biome still formats and runs the repo-wide lint; this adds what Biome
 * cannot: the React hooks rules, the slop rules, the bans on effects, useState and global stores,
 * and a short list of typed rules. The README's "React rules" and "State" sections say why.
 */
import comments from '@eslint-community/eslint-plugin-eslint-comments';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import { createSlopConfig } from 'eslint-plugin-slop';
import tseslint from 'typescript-eslint';

const noUseState =
  'useState is banned. Put app and flow state in the app store (useAppStore, src/state/). useReducer only for state that belongs to one component and never leaves it.';
const noEffects =
  'Effects are banned. Derive the value during render, do the work in an event handler, a ref callback or a store action, or read outside state with useSyncExternalStore.';
const toolsTypesOnly =
  "Import only types from @signforge/tools (import type): a value import puts the tools' schemas, or their handlers, in the browser bundle. src/lib/tools.ts says how a call is typed.";
const noGlobalStore =
  "zustand's create() makes one store for the whole server, shared between requests. Add a slice to src/state/ and read it with useAppStore.";

export default defineConfig(
  { ignores: ['dist/**', '.wrangler/**', '.e2e/**', 'test-results/**', 'src/routeTree.gen.ts', 'worker-configuration.d.ts'] },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  {
    files: ['src/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    // The type information comes from the TypeScript 6 alias in package.json: typescript-eslint cannot load TypeScript 7.
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { '@typescript-eslint': tseslint.plugin, 'eslint-comments': comments },
    // Full inspection, not the default of recent changes only, so a result never depends on git history.
    extends: [createSlopConfig({ cwd: import.meta.dirname, inspection: 'full' })],
    rules: {
      'eslint-comments/require-description': 'error',
      'preserve-caught-error': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { allowDefaultCaseForExhaustiveSwitch: false }],
      // TanStack Router's redirect() and notFound() are thrown on purpose.
      '@typescript-eslint/only-throw-error': ['error', { allow: [{ from: 'package', package: '@tanstack/router-core', name: ['Redirect', 'NotFoundError'] }] }],
      '@typescript-eslint/no-deprecated': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', importNames: ['useState'], message: noUseState },
            { name: 'react', importNames: ['useEffect', 'useLayoutEffect', 'useInsertionEffect'], message: noEffects },
            { name: 'zustand', importNames: ['create'], message: noGlobalStore },
          ],
        },
      ],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@signforge/tools', '@signforge/tools/*'], allowTypeImports: true, message: toolsTypesOnly }] },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[object.name='React'][property.name='useState']", message: noUseState },
        { selector: "MemberExpression[object.name='React'][property.name=/^use(Layout|Insertion)?Effect$/]", message: noEffects },
      ],
    },
  },
);
