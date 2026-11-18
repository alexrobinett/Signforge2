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
 * The browser test screen (M3-41): the player build served as static files at `/test-screen/`. A
 * deploy copies it into the site's assets; `vite dev` serves it from the build.
 */
function testScreen(): Plugin {
  const missing = () => new Error(`no player build at ${PLAYER}: run pnpm build:player first`);
  return {
    name: 'signforge-test-screen',
    configureServer(server) {
      server.middlewares.use('/test-screen', (req, res) => {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        if (req.originalUrl?.split('?')[0] === '/test-screen') {
          res.writeHead(308, { location: `/test-screen/${req.originalUrl.slice('/test-screen'.length)}` });
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
    },
    writeBundle(options) {
      if (this.environment.name !== 'client' || !options.dir) return;
      if (!existsSync(PLAYER)) throw missing();
      cpSync(PLAYER, join(options.dir, 'test-screen'), { recursive: true });
    },
  };
}

export default defineConfig({
  server: { port: 3000, strictPort: true },
  resolve: { tsconfigPaths: true },
  plugins: [testScreen(), cloudflare({ viteEnvironment: { name: 'ssr' } }), tailwindcss(), tanstackStart(), react()],
});
