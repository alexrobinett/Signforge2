/**
 * Every tool, by name. Adding a tool here is all it takes to serve it on `/api/tools`, list it in
 * `GET /api/tools`, and cover it in the generated isolation test.
 */
import { groupTools } from './groups';
import { publishTools } from './publish';
import { screenTools } from './screens';
import type { AnyTool } from './tool';

export const TOOLS: readonly AnyTool[] = [...screenTools, ...groupTools, ...publishTools];

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

function build(tools: readonly AnyTool[]): ReadonlyMap<string, AnyTool> {
  const map = new Map<string, AnyTool>();
  for (const t of tools) {
    if (!NAME.test(t.name)) throw new Error(`tool name ${JSON.stringify(t.name)} must be snake_case`);
    if (map.has(t.name)) throw new Error(`two tools are named ${t.name}`);
    map.set(t.name, t);
  }
  return map;
}

export const registry = build(TOOLS);
