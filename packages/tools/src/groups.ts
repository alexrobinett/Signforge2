/** Screen group tools. A group is a named set of screens that schedules can target. */
import type { OrgScope, ScreenGroup } from '@signforge/db';
import { z } from 'zod';
import { id, idempotencyKey, ifVersion, name, version } from './fields';
import { nextOutput, page, pageInput } from './paging';
import { defineTool, notFound, ToolError } from './tool';

const groupOutput = z.object({
  id: z.string(),
  name: z.string(),
  screenIds: z.array(z.string()).describe('The screens in the group, ordered by id'),
  version: version.describe('Moves on when the name or the screens change; pass it as ifVersion to update only what you read'),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type GroupView = z.infer<typeof groupOutput>;
const groupResult = z.object({ group: groupOutput });

const viewOf = (g: ScreenGroup, screenIds: string[]): GroupView => ({
  id: g.id,
  name: g.name,
  screenIds: screenIds.toSorted(),
  version: g.rowVersion,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
});

const groupView = async (org: OrgScope, g: ScreenGroup) => viewOf(g, await org.screenGroups.members(g.id));

async function requireGroup(org: OrgScope, groupId: string) {
  const row = await org.screenGroups.get(groupId);
  if (!row) throw notFound('group', groupId);
  return row;
}

const target = (input: { groupId: string }) => ({ kind: 'group', id: input.groupId });

const listGroups = defineTool({
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

const createGroup = defineTool({
  name: 'create_group',
  description:
    'Create a screen group, optionally with its first screens. Pass an idempotencyKey so a retry cannot create it twice. Returns { group } with the new id.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z.object({ name: name('group'), screenIds: z.array(id('screen')).max(1000).optional().describe('Screens to put in the group'), idempotencyKey }),
  output: groupResult,
  example: { name: 'Front of house', screenIds: ['scr_example'] },
  target: (_input, output) => ({ kind: 'group', id: output.group.id }),
  handler: async ({ org, input, write }) => {
    // The group and its members are written together, so a bad screen id leaves no empty group behind.
    const screenIds = [...new Set(input.screenIds ?? [])];
    const group = write(org.screenGroups.stage.insert({ name: input.name }));
    if (screenIds.length) write(await org.screenGroups.stage.setMembers(group, screenIds, { newGroup: true }));
    return { group: viewOf(group, screenIds) };
  },
});

const renameGroup = defineTool({
  name: 'rename_group',
  description: 'Rename a screen group. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { group }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group'), name: name('group'), ifVersion }),
  output: groupResult,
  example: { groupId: 'grp_example', name: 'Drive-through' },
  target,
  handler: async ({ org, input, write }) => {
    const group = await requireGroup(org, input.groupId);
    return { group: await groupView(org, write(org.screenGroups.stage.update(group, { name: input.name }, input.ifVersion))) };
  },
});

const deleteGroup = defineTool({
  name: 'delete_group',
  description:
    'Delete a screen group. Its screens are not deleted. Refused with a conflict while a schedule entry targets the group; remove or retarget those entries first. Returns { deleted: groupId }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group') }),
  output: z.object({ deleted: z.string().describe("The deleted group's id") }),
  example: { groupId: 'grp_example' },
  target,
  handler: async ({ org, input, write }) => {
    await requireGroup(org, input.groupId);
    // The schema would cascade the delete to these entries; a person should decide that.
    const entries = (await org.scheduleEntries.list()).filter((e) => e.groupId === input.groupId).map((e) => e.id);
    if (entries.length)
      throw new ToolError('conflict', `group ${input.groupId} is targeted by ${entries.length} schedule entries`, { scheduleEntryIds: entries });
    write(org.screenGroups.stage.delete(input.groupId));
    return { deleted: input.groupId };
  },
});

const setGroupMembers = defineTool({
  name: 'set_group_members',
  description:
    "Replace a group's screens with exactly the given list. An empty list empties the group. Every screen must be in this organization, or nothing changes. To add or remove a few screens, use add_group_members or remove_group_members, which cannot drop a screen someone else added. A replace should pass the version it read as ifVersion. Returns { group }.",
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group'), screenIds: z.array(id('screen')).max(1000), ifVersion }),
  output: groupResult,
  example: { groupId: 'grp_example', screenIds: ['scr_example'] },
  target,
  handler: async ({ org, input, write }) => {
    const group = await requireGroup(org, input.groupId);
    const row = write(await org.screenGroups.stage.setMembers(group, input.screenIds, { ifVersion: input.ifVersion }));
    return { group: viewOf(row, [...new Set(input.screenIds)]) };
  },
});

const memberIds = z.array(id('screen')).min(1).max(1000);

const addGroupMembers = defineTool({
  name: 'add_group_members',
  description:
    'Add screens to a group. Screens already in it stay; every screen must be in this organization, or nothing changes. Safe alongside other changes to the group: nothing is dropped. Returns { group }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group'), screenIds: memberIds.describe('Screens to add') }),
  output: groupResult,
  example: { groupId: 'grp_example', screenIds: ['scr_example'] },
  target,
  handler: async ({ org, input, write }) => {
    const group = await requireGroup(org, input.groupId);
    const before = await org.screenGroups.members(group.id);
    const row = write(await org.screenGroups.stage.addMembers(group, input.screenIds));
    return { group: viewOf(row, [...new Set([...before, ...input.screenIds])]) };
  },
});

const removeGroupMembers = defineTool({
  name: 'remove_group_members',
  description:
    'Remove screens from a group. Screens not in it are ignored, and the screens themselves are not deleted. Safe alongside other changes to the group: nothing else is dropped. Returns { group }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group'), screenIds: memberIds.describe('Screens to remove') }),
  output: groupResult,
  example: { groupId: 'grp_example', screenIds: ['scr_example'] },
  target,
  handler: async ({ org, input, write }) => {
    const group = await requireGroup(org, input.groupId);
    const before = await org.screenGroups.members(group.id);
    const row = write(await org.screenGroups.stage.removeMembers(group, input.screenIds));
    return {
      group: viewOf(
        row,
        before.filter((s) => !input.screenIds.includes(s)),
      ),
    };
  },
});

export const groupTools = [listGroups, createGroup, renameGroup, deleteGroup, setGroupMembers, addGroupMembers, removeGroupMembers];
