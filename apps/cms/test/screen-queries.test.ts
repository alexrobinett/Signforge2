// The status polls over the screen list (#183, re-check of #205): the Screens page's reads the list
// again when what a screen shows changes; Settings' only when a screen comes or goes.
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { screenRosterQuery, screensQuery, screenStatusQuery } from '../src/queries/screens';
import { getScreenStatus } from '../src/server/screens.functions';

vi.mock('~/server/screens.functions', () => ({ getScreens: vi.fn(), getScreenStatus: vi.fn() }));

const ORG = 'org_1';
const online = { kind: 'online', reason: null, wakesAt: null, filesMissing: null };
const screen = (id: string, manifest: string) => ({ id, state: online, lastSeenAt: 1, desiredManifestId: manifest, reportedManifestId: manifest });

function withList() {
  const client = new QueryClient();
  client.setQueryData(screensQuery(ORG).queryKey, { screens: [screen('scr_1', 'man_1')], groups: [], at: 0 } as never);
  const listInvalidated = () => client.getQueryState(screensQuery(ORG).queryKey)?.isInvalidated;
  return { client, listInvalidated };
}

describe('screenRosterQuery', () => {
  it('leaves the list alone when only what a screen shows changed', async () => {
    const { client, listInvalidated } = withList();
    vi.mocked(getScreenStatus).mockResolvedValue({ screens: [screen('scr_1', 'man_2')], at: 1 } as never);
    await client.query(screenRosterQuery(ORG));
    expect(listInvalidated()).toBe(false);
    // The Screens page's poll, which shows what each screen plays, reads it again.
    await client.query(screenStatusQuery(ORG));
    expect(listInvalidated()).toBe(true);
  });

  it('reads the list again when a screen comes or goes', async () => {
    const { client, listInvalidated } = withList();
    vi.mocked(getScreenStatus).mockResolvedValue({ screens: [screen('scr_1', 'man_1'), screen('scr_2', 'man_1')], at: 1 } as never);
    await client.query(screenRosterQuery(ORG));
    expect(listInvalidated()).toBe(true);
  });
});
