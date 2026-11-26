/**
 * Every tool, by name. Adding a tool here is all it takes to serve it on `/api/tools`, list it in
 * `GET /api/tools`, and cover it in the generated isolation test.
 *
 * `platformRegistry` is separate: the tools `/admin` runs with `platform(db)` on what belongs to
 * no org (base templates). It is never served on `/api`, so no org member can reach it.
 */
import type { PlatformScope } from '@signforge/db';
import { agentGrantTools } from './agent-grants';
import { aiProviderTools } from './ai-providers';
import { alertChannelTools } from './alert-channels';
import { assetTools } from './assets';
import { auditTools } from './audit';
import { brandTools } from './brand';
import { connectionTools } from './connections';
import { dataSourceTools } from './data-sources';
import { deleteTools } from './delete';
import { groupTools } from './groups';
import { labelTools } from './labels';
import { memberTools } from './members';
import { pairingTools } from './pairing';
import { agentDraftTools } from './agent-drafts';
import { playlistTools } from './playlists';
import { agentOutputOf, readTools } from './read';
import { publishRequestTools } from './publish-requests';
import { publishTools } from './publish';
import { scheduleTools } from './schedule';
import { screenTools } from './screens';
import { settingsTools } from './settings';
import { spotTools } from './spots';
import { platformTemplateTools, templateTools } from './templates';
import type { AnyTool, DataScope } from './tool';
import { uploadTools } from './uploading';

/** Every tool but `read` and `describe`, which read and describe these. */
const BASE_TOOLS: readonly AnyTool[] = [
  ...screenTools,
  ...pairingTools,
  ...groupTools,
  ...labelTools,
  ...publishTools,
  ...publishRequestTools,
  ...templateTools,
  ...assetTools,
  ...uploadTools,
  ...brandTools,
  ...dataSourceTools,
  ...connectionTools,
  ...settingsTools,
  ...alertChannelTools,
  ...aiProviderTools,
  ...spotTools,
  ...playlistTools,
  ...agentDraftTools,
  ...scheduleTools,
  ...deleteTools,
  ...auditTools,
  ...memberTools,
  ...agentGrantTools,
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

export const TOOLS: readonly AnyTool[] = [...BASE_TOOLS, ...readTools(build(BASE_TOOLS))];

export const registry = build(TOOLS);

/** A tool's output as an agent reads it, its times ISO 8601 (#345): `/mcp`'s results and the drawer's tool outputs. */
export const agentOutput = agentOutputOf(registry);
export const platformRegistry = build(PLATFORM_TOOLS);
