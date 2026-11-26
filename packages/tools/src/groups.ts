/** Screen group tools. A group is a named set of screens that schedules can target. */
import type { OrgScope, ScreenGroup } from '@signforge/db';
import { z } from 'zod';
import { id, idempotencyKey, ifVersion, name } from './fields';
import { page, pageInput } from './paging';
import { ended } from './schedule';
import { defineTool, notFound, ToolError } from './tool';
import { outputs, type GroupView } from './outputs';

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
  output: outputs.list_groups,
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = page(await org.screenGroups.list(), (g) => [g.id], input);
    return { groups: await Promise.all(rows.map((g) => groupView(org, g))), next };
  },
});

const saveGroup = defineTool({
  name: 'save_group',
  description:
    "Create a screen group, or change one: its name and its screens. Without groupId it creates one, with a name and optionally its first screens in screenIds; pass an idempotencyKey so a retry cannot create it twice. With groupId it changes what you give: name renames it, and screenIds with membership changes its screens. membership add puts them in and remove takes them out, leaving every other screen as it is, so both are safe alongside other changes; set makes them exactly the group's screens (an empty list empties it). Every screen must be in this organization, or nothing changes; remove ignores a screen not in the group. Pass the version you read as ifVersion with name or set, so a change made since is not overwritten. Returns { group }.",
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  // Strict: a field it does not take (the old tools' add or remove lists) is refused by name, not dropped.
  input: z
    .strictObject({
      groupId: id('group').optional().describe('The group to change; omit to create one'),
      name: name('group').optional(),
      screenIds: z.array(id('screen')).max(1000).optional().describe("A new group's first screens, or the screens membership adds, removes or sets"),
      membership: z.enum(['add', 'remove', 'set']).optional().describe("How screenIds change a group's screens; needed with groupId"),
      ifVersion,
      idempotencyKey,
    })
    .superRefine((v, ctx) => {
      const problem =
        v.membership !== undefined && v.screenIds === undefined
          ? 'membership needs the screenIds it adds, removes or sets'
          : v.groupId === undefined
            ? v.name === undefined
              ? 'a new group needs a name; give groupId to change one'
              : v.membership === 'remove'
                ? 'a new group has no screens to remove'
                : v.ifVersion !== undefined
                  ? 'a new group has no version yet: ifVersion is for a change'
                  : undefined
            : (v.membership === 'add' || v.membership === 'remove') && v.screenIds?.length === 0
              ? `give the screens to ${v.membership}: an empty list changes nothing (membership set with an empty list empties the group)`
              : v.screenIds !== undefined && v.membership === undefined
                ? 'give membership with screenIds: add, remove or set'
                : v.name === undefined && v.screenIds === undefined
                  ? 'give a name or screenIds to change'
                  : undefined;
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  output: outputs.save_group,
  example: { name: 'Front of house', screenIds: ['scr_example'] },
  target: (input, output) => ({ kind: 'group', id: input.groupId ?? output.group.id }),
  handler: async ({ org, input, write }) => {
    const screenIds = [...new Set(input.screenIds ?? [])];
    if (input.groupId === undefined) {
      // The group and its members are written together, so a bad screen id leaves no empty group behind.
      const group = write(org.screenGroups.stage.insert({ name: input.name! }));
      if (screenIds.length) write(await org.screenGroups.stage.setMembers(group, screenIds, { newGroup: true }));
      return { group: viewOf(group, screenIds) };
    }
    let group = await requireGroup(org, input.groupId);
    let members = input.membership === 'set' ? screenIds : await org.screenGroups.members(group.id);
    // The version read guards the first change; a second follows it in the same batch.
    let guard = input.ifVersion;
    if (input.name !== undefined) {
      group = write(org.screenGroups.stage.update(group, { name: input.name }, guard));
      guard = undefined;
    }
    if (input.membership === 'set') group = write(await org.screenGroups.stage.setMembers(group, screenIds, { ifVersion: guard }));
    if (input.membership === 'add') {
      group = write(await org.screenGroups.stage.addMembers(group, screenIds, guard));
      members = [...new Set([...members, ...screenIds])];
    }
    if (input.membership === 'remove') {
      group = write(await org.screenGroups.stage.removeMembers(group, screenIds, guard));
      members = members.filter((s) => !screenIds.includes(s));
    }
    return { group: viewOf(group, members) };
  },
});

const deleteGroup = defineTool({
  name: 'delete_group',
  description:
    'Delete a screen group. Its screens are not deleted. Refused with a conflict while a schedule entry targets the group; remove or retarget those entries first. Takeovers of it that have ended do not count, and are deleted with it. Returns { deleted: groupId }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ groupId: id('group') }),
  output: outputs.delete_group,
  example: { groupId: 'grp_example' },
  target,
  handler: async ({ org, input, write }) => {
    await requireGroup(org, input.groupId);
    // The schema would cascade the delete to these entries; a person should decide that. An ended
    // takeover plays nowhere again: the cascade takes it.
    const now = Date.now();
    const entries = (await org.scheduleEntries.list()).filter((e) => e.groupId === input.groupId && !ended(e, now)).map((e) => e.id);
    if (entries.length)
      throw new ToolError('conflict', `group ${input.groupId} is targeted by ${entries.length} schedule entries`, { scheduleEntryIds: entries });
    write(org.screenGroups.stage.delete(input.groupId));
    return { deleted: input.groupId };
  },
});

export const groupTools = [listGroups, saveGroup, deleteGroup];
