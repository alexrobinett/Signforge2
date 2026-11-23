// Turborepo's remote cache over one R2 bucket: the calls turbo 2.11 makes when it runs tasks
// (docs/ci.md, "Remote cache"). Artifacts are signed by the clients (`remoteCache.signature` in
// turbo.json), so this Worker stores the tag and never needs the key. Two bearer tokens: TURBO_TOKEN
// reads and writes (CI), TURBO_READ_TOKEN only reads (laptops). Old entries expire by the bucket's
// lifecycle rule, not here.
//
// Not served: POST /v8/artifacts, the batch lookup only `--dry` uses (turbo falls back to a HEAD
// per hash when it 404s), and POST /v8/artifacts/events, Vercel's usage analytics.

const ARTIFACT = /^\/v8\/artifacts\/([0-9a-f]{1,64})$/;
// `slug` is TURBO_TEAM, `teamId` TURBO_TEAMID: one names the folder each team's artifacts live in.
const TEAM = /^[\w-]{1,64}$/;

type Access = 'read' | 'write';

const failure = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

async function digest(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

/** What the request's bearer token may do. Hashing gives both sides the same length, which timingSafeEqual needs. */
async function access(request: Request, env: Env): Promise<Access | undefined> {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (token === undefined) return undefined;
  const [given, write, read] = await Promise.all([digest(token), digest(env.TURBO_TOKEN), digest(env.TURBO_READ_TOKEN)]);
  if (crypto.subtle.timingSafeEqual(given, write)) return 'write';
  if (crypto.subtle.timingSafeEqual(given, read)) return 'read';
  return undefined;
}

/** The headers turbo reads on a hit: the task's duration (the time a replay saves) and the signature tag. */
function artifactHeaders(object: R2Object): Headers {
  const headers = new Headers({ 'content-type': 'application/octet-stream' });
  const { duration, tag } = object.customMetadata ?? {};
  if (duration !== undefined) headers.set('x-artifact-duration', duration);
  if (tag !== undefined) headers.set('x-artifact-tag', tag);
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = await access(request, env);
    if (allowed === undefined) return failure(401, 'unauthorized', 'missing or unknown bearer token');

    if (url.pathname === '/v8/artifacts/status' && request.method === 'GET') {
      return Response.json({ status: 'enabled', readOnly: allowed === 'read' });
    }

    const hash = ARTIFACT.exec(url.pathname)?.[1];
    if (hash === undefined) return failure(404, 'not_found', `no route for ${request.method} ${url.pathname}`);
    const team = url.searchParams.get('slug') ?? url.searchParams.get('teamId');
    if (team === null || !TEAM.test(team)) return failure(400, 'bad_request', 'set TURBO_TEAM to a slug of letters, digits, - and _');
    const key = `${team}/${hash}`;

    switch (request.method) {
      case 'GET': {
        const object = await env.ARTIFACTS.get(key);
        return object === null ? failure(404, 'not_found', 'no such artifact') : new Response(object.body, { headers: artifactHeaders(object) });
      }
      case 'HEAD': {
        const object = await env.ARTIFACTS.head(key);
        return new Response(null, object === null ? { status: 404 } : { headers: artifactHeaders(object) });
      }
      case 'PUT': {
        if (allowed === 'read') return failure(403, 'forbidden', 'this token only reads the cache');
        if (request.body === null) return failure(400, 'bad_request', 'an artifact needs a body');
        const customMetadata: Record<string, string> = {};
        const duration = request.headers.get('x-artifact-duration');
        const tag = request.headers.get('x-artifact-tag');
        // turbo fails a hit whose duration is not a whole number of milliseconds.
        if (duration !== null && /^\d{1,15}$/.test(duration)) customMetadata.duration = duration;
        if (tag !== null) customMetadata.tag = tag;
        await env.ARTIFACTS.put(key, request.body, { customMetadata });
        return new Response(null, { status: 202 });
      }
      default:
        return failure(405, 'method_not_allowed', `${request.method} is not served here`);
    }
  },
} satisfies ExportedHandler<Env>;
