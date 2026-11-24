/**
 * The tools a spike turn offers (#346). Two read-only registry tools, wrapped as they are: the
 * registry's name, description and zod input, and `dispatch()` as the only way they run, as the
 * member via cms-agent. No second catalog: nothing here restates a tool. The model reads each
 * result fenced as data; the card gets the object as result metadata, which the model never sees.
 *
 * And one dummy dangerous tool, `restart_screens`, with `needsApproval`, to see whether a run pauses
 * before it and resumes after a click without running it first. It writes nothing: it counts its runs.
 */
import { type Caller, dispatch, registry } from '@signforge/tools';
import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';

/** The registry tools the spike offers: read-only, `content:read`. */
const READ_TOOLS = ['list_screens', 'list_playlists'] as const;

/** Untrusted text for the model, fenced as apps/api's `fenced` does. */
const fenced = (kind: string, text: string) => `<${kind}>\n${text.replaceAll(`</${kind}>`, `<\\/${kind}>`)}\n</${kind}>`;

export function registryTools(caller: Caller) {
  return READ_TOOLS.map((name) => {
    const tool = registry.get(name);
    if (!tool || tool.mutates) throw new Error(`${name} is not a read-only registry tool`);
    return toolDefinition({ name, description: tool.description, inputSchema: tool.input, resultMetadataSchema: z.record(z.string(), z.unknown()) }).server(
      async (input, context) => {
        const out = await dispatch(registry, name, input, caller);
        if (!out.ok) return fenced('data', JSON.stringify({ error: out.error, message: out.message }));
        // A registry tool's output is an object: the card reads it, the model reads the fenced text.
        if (typeof out.output === 'object' && out.output !== null) context?.setResultMetadata?.(Object.fromEntries(Object.entries(out.output)));
        return fenced('data', JSON.stringify(out.output));
      },
    );
  });
}

/** How many times `restart_screens` ran: a test reads it to see a paused call did not run. */
export const restarts = { count: 0 };

export const restartScreens = toolDefinition({
  name: 'restart_screens',
  description: 'Restart every screen of the organization now. Screens go blank while they restart.',
  inputSchema: z.object({ reason: z.string().max(200) }),
  needsApproval: true,
}).server(async () => {
  restarts.count++;
  return 'restarted';
});
