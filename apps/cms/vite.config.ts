import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { appendFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** The player build (`pnpm build:player`), built with no CMS_ORIGIN: its own origin, this site's, is the CMS. */
const PLAYER = fileURLToPath(new URL('../../dist/player/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
/**
 * The policy the player is served under here: it reaches this site and no other. The player takes its content base
 * and its supervisor from its address (`?content=`, `?supervisor=`), which on this hostname anyone can write into a
 * link; without the policy it would play whatever that site published, a live page included, under the CMS's address.
 * Its own uses here name this site only: the test screen's device API, and the stage's drafts and files.
 */
const PLAYER_POLICY = "connect-src 'self'";

/**
 * The player build served as static files at `/test-screen/` (the browser test screen, M3-41) and at
 * `/player/` (the spot editor's stage, M3-16). Two paths, so each gets its own service worker scope. A
 * deploy copies it into the site's assets; `vite dev` serves it from the build. Either way under `PLAYER_POLICY`:
 * a deploy's assets get it from `_headers`, the file Workers Static Assets reads response headers from.
 */
function playerBuild(): Plugin {
  const MOUNTS = ['/test-screen', '/player'];
  const missing = () => new Error(`no player build at ${PLAYER}: run pnpm build:player first`);
  return {
    name: 'signforge-player-build',
    configureServer(server) {
      for (const mount of MOUNTS) {
        server.middlewares.use(mount, (req, res) => {
          const path = new URL(req.url ?? '/', 'http://x').pathname;
          if (req.originalUrl?.split('?')[0] === mount) {
            res.writeHead(308, { location: `${mount}/${req.originalUrl.slice(mount.length)}` });
            return void res.end();
          }
          const file = join(PLAYER, normalize(path === '/' ? 'index.html' : path).replace(/^(\.\.[/\\])+/, ''));
          if (!existsSync(PLAYER)) throw missing();
          if (!file.startsWith(PLAYER) || !existsSync(file)) {
            res.writeHead(404);
            return void res.end();
          }
          res.writeHead(200, {
            'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
            'cache-control': 'no-store',
            'content-security-policy': PLAYER_POLICY,
          });
          res.end(readFileSync(file));
        });
      }
    },
    writeBundle(options) {
      if (this.environment.name !== 'client' || !options.dir) return;
      if (!existsSync(PLAYER)) throw missing();
      for (const mount of MOUNTS) {
        cpSync(PLAYER, join(options.dir, mount.slice(1)), { recursive: true });
        // Every file under the mount: the player's workers take their policy from their own script's response.
        appendFileSync(join(options.dir, '_headers'), `${mount}/*\n  Content-Security-Policy: ${PLAYER_POLICY}\n`);
      }
    },
  };
}

export default defineConfig({
  server: { port: 3000, strictPort: true },
  resolve: { tsconfigPaths: true },
  plugins: [
    playerBuild(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart({
      // The dev environment's build (the e2e's CMS) names each server function in its URL, as
      // `vite dev` does, so a test can hold or fail one read by name. Deployed builds keep hashes.
      serverFns: { generateFunctionId: process.env.CLOUDFLARE_ENV === 'dev' ? ({ functionName }) => functionName : undefined },
    }),
    react(),
  ],
});
