import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** The player build (`pnpm build:player`), built with no CMS_ORIGIN: its own origin, this site's, is the CMS. */
const PLAYER = fileURLToPath(new URL('../../dist/player/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/**
 * The player build served as static files at `/test-screen/` (the browser test screen, M3-41) and at
 * `/player/` (the spot editor's stage, M3-16). Two paths, so each gets its own service worker scope. A
 * deploy copies it into the site's assets; `vite dev` serves it from the build.
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
          res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
          res.end(readFileSync(file));
        });
      }
    },
    writeBundle(options) {
      if (this.environment.name !== 'client' || !options.dir) return;
      if (!existsSync(PLAYER)) throw missing();
      for (const mount of MOUNTS) cpSync(PLAYER, join(options.dir, mount.slice(1)), { recursive: true });
    },
  };
}

export default defineConfig({
  server: { port: 3000, strictPort: true },
  resolve: { tsconfigPaths: true },
  plugins: [playerBuild(), cloudflare({ viteEnvironment: { name: 'ssr' } }), tailwindcss(), tanstackStart(), react()],
});
