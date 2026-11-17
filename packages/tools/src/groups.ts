/** Screen group tools. A group is a named set of screens that schedules can target. */
import type { OrgScope, ScreenGroup } from '@signforge/db';
import { z } from 'zod';
import { id, idempotencyKey, name } from './fields';
import { defineTool, notFound, ToolError } from './tool';

export interface GroupView {
  id: string;
  name: string;
  /** Ids of the screens in the group, ordered by id. */
  screenIds: string[];
  createdAt: number;
  updatedAt: number;
}

const viewOf = (g: ScreenGroup, screenIds: string[]): GroupView => ({ id: g.id, name: g.name, screenIds: screenIds.toSorted(), createdAt: g.createdAt, updatedAt: g.updatedAt });

const groupView = async (org: OrgScope, g: ScreenGroup) => viewOf(g, await org.screenGroups.members(g.id));

async function requireGroup(org: OrgScope, groupId: string) {
  const row = await org.screenGroups.get(groupId);
  if (!row) throw notFound('group', groupId);
  return row;
}

const target = (input: { groupId: string }) => ({ kind: 'group', id: input.groupId });

export const listGroups = defineTool({
  name: 'list_groups',
  description: 'List every screen group in the organization with the ids of its screens, ordered by id. Returns { groups: Group[] }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({}),
  example: {},
  handler: async ({ org }) => ({ groups: await Promise.all((await org.screenGroups.list()).map((g) => groupView(org, g))) }),
});

export const createGroup = defineTool({
  name: 'create_group',
  description: 'Create a screen group, optionally with its first screens. Pass an idempotencyKey so a retry cannot create it twice. Returns { group } with the new id.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z.object({ name: name('group'), screenIds: z.array(id('screen')).max(1000).optional().describe('Screens to put in the group'), idempotencyKey }),
  example: { name: 'Front of house', screenIds: ['scr_example'] },
  target: (_input, output: { group: GroupView }) => ({ kind: 'group', id: output.group.id }),
  handler: async ({ org, input, write }) => {
    // The group and its members are written together, so a bad screen id leaves no empty group behind.
    const screenIds = [...new Set(input.screenIds ?? [])];
    const group = write(org.screenGroups.stage.insert({ name: input.name }));
    if (screenIds.length) write(await org.screenGroups.stage.setMembers(group.id, screenIds, { newGroup: true }));
    return { group: viewOf(group, screenIds) };
  },
});

export const renameGroup = defineTool({
  name: 'rename_group',
  description: 'Rename a screen group. Returns { group }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group'), name: name('group') }),
  example: { groupId: 'grp_example', name: 'Drive-through' },
  target,
  handler: async ({ org, input, write }) => {
    const group = await requireGroup(org, input.groupId);
    return { group: await groupView(org, write(org.screenGroups.stage.update(group, { name: input.name }))) };
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
  example: { groupId: 'grp_example' },
  target,
  handler: async ({ org, input, write }) => {
    await requireGroup(org, input.groupId);
    // The schema would cascade the delete to these entries; a person should decide that.
    const entries = (await org.scheduleEntries.list()).filter((e) => e.groupId === input.groupId).map((e) => e.id);
    if (entries.length) throw new ToolError('conflict', `group ${input.groupId} is targeted by ${entries.length} schedule entries`, { scheduleEntryIds: entries });
    write(org.screenGroups.stage.delete(input.groupId));
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
  example: { groupId: 'grp_example', screenIds: ['scr_example'] },
  target,
  handler: async ({ org, input, write }) => {
    const group = await requireGroup(org, input.groupId);
    write(await org.screenGroups.stage.setMembers(group.id, input.screenIds));
    return { group: viewOf(group, [...new Set(input.screenIds)]) };
  },
});

export const groupTools = [listGroups, createGroup, renameGroup, deleteGroup, setGroupMembers];
