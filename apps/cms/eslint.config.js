/**
 * React rules for the CMS. Biome still formats and runs the repo-wide lint; this adds what Biome
 * cannot: the React hooks rules, the slop rules, and the bans on effects, useState and global
 * stores. The README's "React rules" and "State" sections say why.
 */
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import { createSlopConfig } from 'eslint-plugin-slop';
import tseslint from 'typescript-eslint';

const noUseState =
  'useState is banned. Put app and flow state in the app store (useAppStore, src/state/). useReducer only for state that belongs to one component and never leaves it.';
const noEffects =
  'Effects are banned. Derive the value during render, do the work in an event handler, a ref callback or a store action, or read outside state with useSyncExternalStore.';
const noGlobalStore =
  "zustand's create() makes one store for the whole server, shared between requests. Add a slice to src/state/ and read it with useAppStore.";

export default defineConfig(
  { ignores: ['dist/**', '.wrangler/**', '.e2e/**', 'test-results/**', 'src/routeTree.gen.ts', 'worker-configuration.d.ts'] },
  {
    files: ['src/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    // Full inspection, not the default of recent changes only, so a result never depends on git history.
    extends: [createSlopConfig({ cwd: import.meta.dirname, inspection: 'full' })],
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
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[object.name='React'][property.name='useState']", message: noUseState },
        { selector: "MemberExpression[object.name='React'][property.name=/^use(Layout|Insertion)?Effect$/]", message: noEffects },
      ],
    },
  },
);
