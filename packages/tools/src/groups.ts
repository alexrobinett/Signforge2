/**
 * Screen group tools. A group is a named set of screens that schedules can target: screens listed, or a smart group
 * (#186), every screen its selector matches when a publish resolves it (./memberships.ts).
 */
import type { OrgScope, ScreenGroup } from '@signforge/db';
import type { Selector } from '@signforge/compiler/selector';
import { orgGroups, ruleOf } from './memberships';
import { page } from './paging';
import { ended } from './schedule';
import { defineTool, notFound, ToolError } from './tool';
import { outputs, type GroupView } from './outputs';
import { inputs } from './inputs';

const viewOf = (g: ScreenGroup, screenIds: string[]): GroupView => ({
  id: g.id,
  name: g.name,
  screenIds: screenIds.toSorted(),
  selector: ruleOf(g),
  version: g.rowVersion,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
});

async function requireGroup(org: OrgScope, groupId: string) {
  const row = await org.screenGroups.get(groupId);
  if (!row) throw notFound('group', groupId);
  return row;
}

const target = (input: { groupId: string }) => ({ kind: 'group', id: input.groupId });

const listGroups = defineTool({
  name: 'list_groups',
  description:
    "List the organization's screen groups with their screens' ids, a smart group's as its rule matches now, ordered by id, a page at a time. Returns { groups: Group[], next }; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: inputs.list_groups,
  output: outputs.list_groups,
  example: {},
  handler: async ({ org, input }) => {
    const { groups, screensIn } = await orgGroups(org, { groups: true });
    const { rows, next } = page(groups, (g) => [g.id], input);
    return { groups: rows.map((g) => viewOf(g, screensIn(g.id))), next };
  },
});

const saveGroup = defineTool({
  name: 'save_group',
  description:
    'Create or change a screen group: listed screens, or a smart group, the screens its selector matches at each publish. Without groupId: a name, screenIds or a selector, and an idempotencyKey. With groupId: name renames; selector sets the rule; screenIds with membership changes a list. Pass ifVersion with name, selector or set. Returns { group }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  // Strict: a field it does not take (the old tools' add or remove lists) is refused by name, not dropped.
  input: inputs.save_group,
  output: outputs.save_group,
  example: { name: 'Front of house', screenIds: ['scr_example'] },
  target: (input, output) => {
    const id = input.groupId ?? output?.group.id;
    return id === undefined ? undefined : { kind: 'group', id };
  },
  handler: async ({ org, input, write }) => {
    const screenIds = [...new Set(input.screenIds ?? [])];
    // The screens a rule matches now, read only for a rule (review of #608).
    const matching = async (rule: Selector) => (await orgGroups(org)).matching(rule);
    if (input.groupId === undefined) {
      // The group and its members are written together, so a bad screen id leaves no empty group behind.
      const rule = input.selector ?? null;
      const group = write(org.screenGroups.stage.insert({ name: input.name!, selectorJson: rule && JSON.stringify(rule) }));
      if (screenIds.length) write(await org.screenGroups.stage.setMembers(group, screenIds, { newGroup: true }));
      return { group: viewOf(group, rule ? await matching(rule) : screenIds) };
    }
    let group = await requireGroup(org, input.groupId);
    // A smart group's screens are its rule's: membership changes are refused until it is a list again (selector null).
    if (input.membership !== undefined && ruleOf(group) !== null)
      throw new ToolError('conflict', `group ${group.id} is defined by a rule: change its selector, or set selector null to list its screens`);
    let members = input.membership === 'set' ? screenIds : await org.screenGroups.members(group.id);
    // The version read guards the first change; a second follows it in the same batch.
    let guard = input.ifVersion;
    if (input.name !== undefined || input.selector !== undefined) {
      const rule = input.selector === undefined ? {} : { selectorJson: input.selector && JSON.stringify(input.selector) };
      group = write(org.screenGroups.stage.update(group, { ...(input.name === undefined ? {} : { name: input.name }), ...rule }, guard));
      guard = undefined;
    }
    // A rule replaces the list: its member rows go, so nothing stale stands if it is made a list again.
    if (input.selector && members.length) {
      group = write(await org.screenGroups.stage.setMembers(group, []));
      members = [];
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
    const rule = ruleOf(group);
    return { group: viewOf(group, rule ? await matching(rule) : members) };
  },
});

const deleteGroup = defineTool({
  name: 'delete_group',
  description:
    'Delete a screen group. Its screens are not deleted. Refused with a conflict while a schedule entry targets the group; remove or retarget those entries first. Takeovers of it that have ended do not count, and are deleted with it. Returns { deleted: groupId }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: inputs.delete_group,
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
