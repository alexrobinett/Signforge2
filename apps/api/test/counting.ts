// Counting what a request costs (the Free plan: 50 D1 queries an invocation): the API's bindings with
// D1's statements and batches and each Durable Object RPC counted, and a member's calls through them.
import { env } from 'cloudflare:workers';
import { Client } from './client';

/** What `run` costs on bindings that count it (`counted`). */
export async function measure(run: (bindings: Env) => Promise<unknown>) {
  const { result, bindings } = counted();
  await run(bindings);
  return result();
}

/** `who`, signed in as they are, calling through `bindings`. */
export function as(who: Client, bindings: Env) {
  const c = new Client(who.t, who.ip, bindings);
  for (const [k, v] of who.jar) c.jar.set(k, v);
  return c;
}

/**
 * The API's bindings, counting D1's work and each Durable Object RPC. `statements` is every statement
 * prepared; `queries` what D1 counts against an invocation's 50: each statement run alone, and each
 * batch once. `rpcs` names each method called on an object's stub (`acquire`, `release`, `write`).
 */
export function counted(beforeBatch?: () => Promise<unknown>) {
  const seen = { statements: 0, queries: 0, rpcs: [] as string[] };
  let batched = 0;
  let batches = 0;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') seen.statements++;
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          batched += statements.length;
          batches++;
          // A change that lands between a call's reads and its batch, once.
          const before = beforeBatch;
          beforeBatch = undefined;
          await before?.();
          return target.batch(statements);
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const objects = (ns: DurableObjectNamespace): DurableObjectNamespace =>
    new Proxy(ns, {
      get(target, key) {
        const v = Reflect.get(target, key);
        if (key !== 'get') return typeof v === 'function' ? v.bind(target) : v;
        return (id: DurableObjectId) =>
          new Proxy(target.get(id), {
            get(stub, method) {
              const real = Reflect.get(stub, method);
              if (typeof method !== 'string' || typeof real !== 'function') return real;
              return (...args: unknown[]) => (seen.rpcs.push(method), Reflect.apply(real, stub, args));
            },
          });
      },
    });
  const bindings: Env = { ...env, DB: db, AGENT_GRANTS: objects(env.AGENT_GRANTS) as Env['AGENT_GRANTS'], ORGS: objects(env.ORGS) as Env['ORGS'] };
  // Every statement run alone is a query, and every batch one more, however many it holds.
  const result = () => ({ statements: seen.statements, queries: seen.statements - batched + batches, rpcs: seen.rpcs });
  return { result, bindings };
}

