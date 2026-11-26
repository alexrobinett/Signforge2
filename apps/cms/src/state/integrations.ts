/**
 * The Integrations page (issue #80): the sources dialog of one kind (add a feed, change a
 * source's URL, switch a news feed's photos off or on, delete one) and connecting accounts at a provider. The sources and connections
 * themselves are Query data (src/queries/integrations.ts); each action invalidates what it changed.
 * The page's filter and search are in its URL.
 */
import type { ConnectionView, ListedSource, SourceFormat, SourceKind } from '~/lib/integrations';
import { callTool, isStale, Refusal, toolMessage } from '~/lib/tools';
import { connectionKeys } from '~/queries/integrations';
import { dataSourceKeys } from '~/queries/spots';
import type { SliceCreator } from './store';

/** A new calendar's look-ahead, as `save_data_source` defaults it. */
const DEFAULT_HORIZON_DAYS = 30;

/** What the add form makes: feeds by address. Weather is made from a place, in the spot editor (#79). */
type AddableFormat = Extract<SourceFormat, 'rss' | 'ical'>;

interface NewSource {
  name: string;
  feedUrl: string;
  /** Null while the field is empty. */
  horizonDays: number | null;
}

interface IntegrationsState {
  /** The kind whose sources the dialog shows; null while it is closed. */
  dialog: SourceKind | null;
  /** The add form is open in the dialog. */
  adding: boolean;
  newSource: NewSource;
  /** The source whose URL is being changed, and the URL typed. */
  editing: string | null;
  feedUrl: string;
  pending: boolean;
  error: string | null;
  /** A news feed's photos switch as it was just set, shown until the saved source comes back (or the save is refused). */
  settingPhotos: { id: string; photos: boolean } | null;
  /** The source whose deletion is being confirmed: its address is sealed, so it cannot be had back. */
  deleting: ListedSource | null;
  /** The connection whose disconnection is being confirmed: getting it back needs the provider's consent again. */
  disconnecting: ConnectionView | null;
  /** What is happening to which connection (a provider's name for a new one). */
  connecting: { id: string; doing: 'connect' | 'disconnect' } | null;
  connectError: string | null;
}

export interface IntegrationsSlice {
  integrations: IntegrationsState;
  /** Opens the dialog over one kind's sources, on the add form (`adding`) or a source's URL (`editing`); null closes it. */
  openSources: (kind: SourceKind | null, open?: { adding?: boolean; editing?: string }) => void;
  openAddSource: (open: boolean) => void;
  editNewSource: (change: Partial<NewSource>) => void;
  addSource: (orgId: string, format: AddableFormat) => Promise<void>;
  /** Opens the form that changes one source's URL; null closes it. */
  editSourceUrl: (sourceId: string | null) => void;
  typeSourceUrl: (feedUrl: string) => void;
  /** Sends the new URL with the version the page read; the poller reads it afresh within a minute. */
  changeSourceUrl: (orgId: string, source: ListedSource) => Promise<void>;
  /** Whether screens get a news feed's story photos, sent with the version the page read. */
  setSourcePhotos: (orgId: string, source: ListedSource, photos: boolean) => Promise<void>;
  /** Opens the confirmation for one source; null closes it. */
  askToDeleteSource: (source: ListedSource | null) => void;
  /** Deletes the source being confirmed. Refused while a spot binds it: the refusal says which. */
  deleteSource: (orgId: string) => Promise<void>;
  /** Sends the browser to the provider's consent page; it comes back to this page through the API's callback. */
  connect: (provider: string, connectionId?: string) => Promise<void>;
  /** Opens the confirmation for one connection; null closes it. */
  askToDisconnect: (connection: ConnectionView | null) => void;
  /** Disconnects the connection being confirmed. */
  disconnect: (orgId: string) => Promise<void>;
  /**
   * A dialog closed (its `onCloseAutoFocus`): focus goes back to what opened it while that can take it;
   * else, from a confirm over the Sources dialog, to that dialog (its deleted row's button is gone, or
   * disabled while the delete runs); else to the page's main region (a fixed source's alert is gone).
   * These dialogs have no trigger for Radix to return to.
   */
  focusBack: (dialog: OpenedDialog, e: Event) => void;
}

type OpenedDialog = 'sources' | 'delete' | 'disconnect';

/** The Sources dialog's element id: where focus goes from a confirm over it once its opener is gone. */
export const SOURCES_DIALOG = 'sources-dialog';

const initialNewSource: NewSource = { name: '', feedUrl: '', horizonDays: DEFAULT_HORIZON_DAYS };

const initial: IntegrationsState = {
  dialog: null,
  adding: false,
  newSource: initialNewSource,
  editing: null,
  feedUrl: '',
  pending: false,
  error: null,
  settingPhotos: null,
  deleting: null,
  disconnecting: null,
  connecting: null,
  connectError: null,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The names of the spots a refused delete names (`details.spotIds`), from the page's list. */
function blockedBy(err: unknown, source: ListedSource): string | null {
  if (!(err instanceof Refusal) || !isRecord(err.details) || !Array.isArray(err.details.spotIds)) return null;
  const names = source.spots.map((s) => s.name);
  return `${source.name} is used by ${names.length ? names.join(', ') : `${err.details.spotIds.length} spots`}. Choose another source in those spots first.`;
}

export const createIntegrationsSlice: SliceCreator<IntegrationsSlice> = (set, get, { queryClient }) => {
  const integrations = (change: (s: IntegrationsState) => IntegrationsState) => set((s) => ({ integrations: change(s.integrations) }));
  const refresh = (orgId: string) => queryClient.invalidateQueries({ queryKey: dataSourceKeys.all(orgId), exact: true });

  async function attempt(run: () => Promise<void>, refused: (err: unknown) => string = toolMessage) {
    integrations((s) => ({ ...s, pending: true, error: null }));
    try {
      await run();
    } catch (err) {
      integrations((s) => ({ ...s, pending: false, error: refused(err) }));
    }
  }

  /** What had focus as each dialog opened: outside state, nothing renders it. */
  const openers = new Map<OpenedDialog, Element | null>();
  const opened = (dialog: OpenedDialog, open: boolean) => {
    if (open) openers.set(dialog, document.activeElement);
  };

  return {
    integrations: initial,

    focusBack(dialog, e) {
      e.preventDefault();
      const el = openers.get(dialog);
      const usable = el instanceof HTMLElement && el.isConnected && el !== document.body && !el.matches(':disabled');
      const sources = dialog !== 'sources' && get().integrations.dialog !== null ? document.getElementById(SOURCES_DIALOG) : null;
      (usable ? el : (sources ?? document.getElementById('main')))?.focus();
    },

    openSources: (dialog, open = {}) => {
      opened('sources', dialog !== null);
      integrations(() => ({ ...initial, dialog, adding: open.adding ?? false, editing: open.editing ?? null }));
    },

    openAddSource: (adding) => integrations((s) => ({ ...s, adding, editing: null, newSource: initialNewSource, error: null })),

    editNewSource: (change) => integrations((s) => ({ ...s, newSource: { ...s.newSource, ...change }, error: null })),

    addSource: (orgId, format) =>
      attempt(async () => {
        const { name, feedUrl, horizonDays } = get().integrations.newSource;
        const url = feedUrl.trim();
        await callTool('save_data_source', {
          // Never the address itself: a private calendar's is a secret, and the name is shown.
          name: name.trim() || (URL.canParse(url) ? new URL(url).hostname : 'Feed'),
          format,
          feedUrl: url,
          ...(format === 'ical' && horizonDays !== null ? { horizonDays } : {}),
          idempotencyKey: crypto.randomUUID(),
        });
        await refresh(orgId);
        integrations((s) => ({ ...s, adding: false, newSource: initialNewSource, pending: false }));
      }),

    editSourceUrl: (editing) => integrations((s) => ({ ...s, editing, adding: false, feedUrl: '', error: null })),

    typeSourceUrl: (feedUrl) => integrations((s) => ({ ...s, feedUrl, error: null })),

    changeSourceUrl: (orgId, source) =>
      attempt(
        async () => {
          await callTool('save_data_source', { dataSourceId: source.id, feedUrl: get().integrations.feedUrl.trim(), ifVersion: source.version });
          await refresh(orgId);
          integrations((s) => ({ ...s, editing: null, feedUrl: '', pending: false }));
        },
        (err) => (isStale(err) ? 'This changed since you opened it. Close this and open it again to see it.' : toolMessage(err)),
      ),

    async setSourcePhotos(orgId, source, photos) {
      integrations((s) => ({ ...s, settingPhotos: { id: source.id, photos } }));
      await attempt(
        async () => {
          await callTool('save_data_source', { dataSourceId: source.id, photos, ifVersion: source.version });
          await refresh(orgId);
          integrations((s) => ({ ...s, pending: false }));
        },
        (err) => (isStale(err) ? 'This changed since you opened it. Close this and open it again to see it.' : toolMessage(err)),
      );
      integrations((s) => ({ ...s, settingPhotos: null }));
    },

    askToDeleteSource: (deleting) => {
      opened('delete', deleting !== null);
      integrations((s) => ({ ...s, deleting, error: null }));
    },

    async deleteSource(orgId) {
      const source = get().integrations.deleting;
      if (!source) return;
      await attempt(
        async () => {
          await callTool('delete', { type: 'data_source', id: source.id });
          await refresh(orgId);
          integrations((s) => ({ ...s, deleting: null, pending: false }));
        },
        (err) => blockedBy(err, source) ?? toolMessage(err),
      );
    },

    async connect(provider, connectionId) {
      integrations((s) => ({ ...s, connecting: { id: connectionId ?? provider, doing: 'connect' }, connectError: null }));
      try {
        window.location.assign((await callTool('start_connection', { provider, ...(connectionId ? { connectionId } : {}) })).authorizeUrl);
      } catch (err) {
        integrations((s) => ({ ...s, connecting: null, connectError: toolMessage(err) }));
      }
    },

    askToDisconnect: (disconnecting) => {
      opened('disconnect', disconnecting !== null);
      integrations((s) => ({ ...s, disconnecting, connectError: null }));
    },

    async disconnect(orgId) {
      const connection = get().integrations.disconnecting;
      if (!connection) return;
      integrations((s) => ({ ...s, connecting: { id: connection.id, doing: 'disconnect' }, connectError: null }));
      try {
        await callTool('disconnect', { connectionId: connection.id });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: connectionKeys.all(orgId), exact: true }),
          // Its sources now fail as disconnected.
          refresh(orgId),
        ]);
        integrations((s) => ({ ...s, connecting: null, disconnecting: null }));
      } catch (err) {
        integrations((s) => ({ ...s, connecting: null, connectError: toolMessage(err) }));
      }
    },
  };
};
