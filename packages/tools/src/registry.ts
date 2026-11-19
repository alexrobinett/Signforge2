/**
 * Every tool, by name. Adding a tool here is all it takes to serve it on `/api/tools`, list it in
 * `GET /api/tools`, and cover it in the generated isolation test.
 *
 * `platformRegistry` is separate: the tools `/admin` runs with `platform(db)` on what belongs to
 * no org (base templates). It is never served on `/api`, so no org member can reach it.
 */
import type { PlatformScope } from '@signforge/db';
import { alertChannelTools } from './alert-channels';
import { assetTools } from './assets';
import { brandTools } from './brand';
import { dataSourceTools } from './data-sources';
import { groupTools } from './groups';
import { pairingTools } from './pairing';
import { publishTools } from './publish';
import { screenTools } from './screens';
import { settingsTools } from './settings';
import { spotTools } from './spots';
import { platformTemplateTools, templateTools } from './templates';
import type { AnyTool, DataScope } from './tool';
import { videoTools } from './videos';

export const TOOLS: readonly AnyTool[] = [
  ...screenTools,
  ...pairingTools,
  ...groupTools,
  ...publishTools,
  ...templateTools,
  ...assetTools,
  ...videoTools,
  ...brandTools,
  ...dataSourceTools,
  ...settingsTools,
  ...alertChannelTools,
  ...spotTools,
];
export const PLATFORM_TOOLS: readonly AnyTool<PlatformScope>[] = [...platformTemplateTools];

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

function build<D extends DataScope>(tools: readonly AnyTool<D>[]): ReadonlyMap<string, AnyTool<D>> {
  const map = new Map<string, AnyTool<D>>();
  for (const t of tools) {
    if (!NAME.test(t.name)) throw new Error(`tool name ${JSON.stringify(t.name)} must be snake_case`);
    if (map.has(t.name)) throw new Error(`two tools are named ${t.name}`);
    map.set(t.name, t);
  }
  return map;
}

export const registry = build(TOOLS);
export const platformRegistry = build(PLATFORM_TOOLS);
