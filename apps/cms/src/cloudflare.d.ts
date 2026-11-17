// `wrangler types --include-runtime=false` declares `Env`; the Workers runtime types are left out
// because they clash with the DOM types the React code needs. These are the few pieces used.
interface Fetcher {
  fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>;
}
declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env;
}
