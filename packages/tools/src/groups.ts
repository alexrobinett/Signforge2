/** Screen group tools. A group is a named set of screens that schedules can target. */
import type { OrgScope, ScreenGroup } from '@signforge/db';
import { z } from 'zod';
import { id, name } from './fields';
import { nextOutput, page, pageInput } from './paging';
import { defineTool, notFound, ToolError } from './tool';

export const groupOutput = z.object({
  id: z.string(),
  name: z.string(),
  screenIds: z.array(z.string()).describe('The screens in the group, ordered by id'),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type GroupView = z.infer<typeof groupOutput>;
const groupResult = z.object({ group: groupOutput });

async function groupView(org: OrgScope, g: ScreenGroup): Promise<GroupView> {
  const screenIds = (await org.screenGroups.members(g.id)).sort();
  return { id: g.id, name: g.name, screenIds, createdAt: g.createdAt, updatedAt: g.updatedAt };
}

const target = (input: { groupId: string }) => ({ kind: 'group', id: input.groupId });

export const listGroups = defineTool({
  name: 'list_groups',
  description:
    'List the screen groups in the organization with the ids of their screens, ordered by id, a page at a time. Returns { groups: Group[], next }; pass next as cursor for the following page.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({ groups: z.array(groupOutput), next: nextOutput }),
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = page(await org.screenGroups.list(), (g) => [g.id], input);
    return { groups: await Promise.all(rows.map((g) => groupView(org, g))), next };
  },
});

export const createGroup = defineTool({
  name: 'create_group',
  description: 'Create a screen group, optionally with its first screens. Returns { group } with the new id.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ name: name('group'), screenIds: z.array(id('screen')).max(1000).optional().describe('Screens to put in the group') }),
  output: groupResult,
  example: { name: 'Front of house', screenIds: ['scr_example'] },
  target: (_input, output) => ({ kind: 'group', id: output.group.id }),
  handler: async ({ org, input }) => {
    // Check the screens first, so a bad id leaves no empty group behind.
    const screenIds = [...new Set(input.screenIds ?? [])];
    const found = new Set((await org.screens.getMany(screenIds)).map((s) => s.id));
    for (const sid of screenIds) if (!found.has(sid)) throw notFound('screen', sid);
    const group = await org.screenGroups.insert({ name: input.name });
    if (screenIds.length) await org.screenGroups.setMembers(group.id, screenIds);
    return { group: await groupView(org, group) };
  },
});

export const renameGroup = defineTool({
  name: 'rename_group',
  description: 'Rename a screen group. Returns { group }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group'), name: name('group') }),
  output: groupResult,
  example: { groupId: 'grp_example', name: 'Drive-through' },
  target,
  handler: async ({ org, input }) => {
    const row = await org.screenGroups.update(input.groupId, { name: input.name });
    if (!row) throw notFound('group', input.groupId);
    return { group: await groupView(org, row) };
  },
});

export const deleteGroup = defineTool({
  name: 'delete_group',
  description:
    'Delete a screen group. Its screens are not deleted. Refused with a conflict while a schedule entry targets the group; remove or retarget those entries first. Returns { deleted: groupId }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group') }),
  output: z.object({ deleted: z.string().describe('The deleted group\'s id') }),
  example: { groupId: 'grp_example' },
  target,
  handler: async ({ org, input }) => {
    if (!(await org.screenGroups.get(input.groupId))) throw notFound('group', input.groupId);
    // The schema would cascade the delete to these entries; a person should decide that.
    const entries = (await org.scheduleEntries.list()).filter((e) => e.groupId === input.groupId).map((e) => e.id);
    if (entries.length) throw new ToolError('conflict', `group ${input.groupId} is targeted by ${entries.length} schedule entries`, { scheduleEntryIds: entries });
    if (!(await org.screenGroups.delete(input.groupId))) throw notFound('group', input.groupId);
    return { deleted: input.groupId };
  },
});

export const setGroupMembers = defineTool({
  name: 'set_group_members',
  description: "Replace a group's screens with exactly the given list. An empty list empties the group. Every screen must be in this organization, or nothing changes. Returns { group }.",
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group'), screenIds: z.array(id('screen')).max(1000) }),
  output: groupResult,
  example: { groupId: 'grp_example', screenIds: ['scr_example'] },
  target,
  handler: async ({ org, input }) => {
    await org.screenGroups.setMembers(input.groupId, input.screenIds);
    const row = await org.screenGroups.get(input.groupId);
    if (!row) throw notFound('group', input.groupId);
    return { group: await groupView(org, row) };
  },
});

export const groupTools = [listGroups, createGroup, renameGroup, deleteGroup, setGroupMembers];
