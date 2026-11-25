/**
 * The tool registry as MCP shows it (M4-06): pure mappings from what `describeTools` and `dispatch`
 * give, so every tool's listing is tested without a request (test/mcp-tools.test.ts).
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { type DispatchResult, describeTools, type Grant, registry, type ToolServices } from '@signforge/tools';

/** Tools that take something away for good: a person should look before an agent runs them. */
const DESTRUCTIVE = /^(delete|revoke|cancel)_|^(roll_back_publish|end_takeover|disconnect)$/;

/** A tool's display name, from its own: `list_screens` is "List screens". */
const titleOf = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1).replaceAll('_', ' ')}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every tool's input is an object (a test holds the registry to it), as MCP wants. */
const isObjectSchema = (s: unknown): s is Tool['inputSchema'] => isRecord(s) && s.type === 'object';

/**
 * The tools a grant may call, as `tools/list` lists them: those `describeTools` gives for it (its
 * scopes capped by the role now), less those only a person may run (`people`: the grant tools) and any
 * that needs a service this caller lacks (the member tools' Better Auth session: an agent has none),
 * each with its input's JSON Schema and hints from the
 * registry. No output schema: a client may check results against one, and the registry's are not
 * written to be checked by other code.
 */
export function listedTools(grant: Grant, services: ToolServices): Tool[] {
  return describeTools(registry, grant).flatMap((described): Tool[] => {
    const tool = registry.get(described.name);
    const runnable = (tool?.needs ?? []).every((need) => services[need] !== undefined);
    if (!tool || tool.people || !runnable || !isObjectSchema(described.inputSchema)) return [];
    return [
      {
        name: described.name,
        title: titleOf(described.name),
        description: described.description,
        inputSchema: described.inputSchema,
        annotations: {
          readOnlyHint: !tool.mutates,
          destructiveHint: tool.mutates && DESTRUCTIVE.test(tool.name),
          // A keyed creation: the same call again, with its key, changes nothing more.
          idempotentHint: tool.idempotent === true,
        },
      },
    ];
  });
}

/**
 * A `tools/call` answer for what `dispatch` returned: the output as `structuredContent` and as JSON
 * text, or a refusal as a result with `isError`, its code, message and details, which the agent reads
 * and acts on. JSON-RPC errors are only for faults in the protocol itself.
 */
export function callResult(result: DispatchResult): CallToolResult {
  if (result.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.output) }],
      ...(isRecord(result.output) ? { structuredContent: result.output } : {}),
    };
  }
  const { error, message, details } = result;
  const refusal = { error, message, ...(details === undefined ? {} : { details }) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(refusal) }], structuredContent: refusal };
}
