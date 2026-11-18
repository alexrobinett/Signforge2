/**
 * The credential of a browser test screen (`?kind=browser`, M3-41): a player in a tab, with no
 * supervisor to keep it. It lives in IndexedDB on the player's origin, so the tab keeps playing
 * after a reload. No supervisor is ever asked: a process on the machine's loopback could otherwise
 * hand the tab a credential that is not its own.
 *
 * It is stored with the device API base it was paired with and used only when the player's base
 * is that one, as a Pi's is (src/credential.ts). The tab runs on the CMS's origin, where anyone can
 * open `/test-screen/?kind=browser&content=<another API>`; the stored credential must not follow.
 */
import type { CredentialState, ScreenCredential } from './credential';

const DB = 'sf-device';
const STORE = 'credential';
const KEY = 'credential';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const open = indexedDB.open(DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  return (await request(open)).transaction(STORE, mode).objectStore(STORE);
}

export class BrowserCredential implements ScreenCredential {
  private value = '';

  constructor(
    /** The device API base the player was opened with: the stored credential is used only if it is bound to this one. */
    private readonly api: string,
  ) {}

  async check(): Promise<CredentialState> {
    if (this.value) return 'held';
    try {
      const got: unknown = await request((await store('readonly')).get(KEY));
      if (typeof got !== 'object' || got === null || !('credential' in got) || typeof got.credential !== 'string' || !got.credential) return 'none';
      if (!('api' in got) || got.api !== this.api) return 'elsewhere';
      this.value = got.credential;
      return 'held';
    } catch {
      // No IndexedDB (a private window may refuse it): pair, and keep the credential until a reload.
      return 'unknown';
    }
  }

  async headers(): Promise<Record<string, string>> {
    await this.check();
    return this.value ? { authorization: `Bearer ${this.value}` } : {};
  }

  async adopt(credential: string): Promise<void> {
    this.value = credential;
    try {
      await request((await store('readwrite')).put({ credential, api: this.api }, KEY));
    } catch {
      // As in check: it lasts until a reload.
    }
  }

  async revoke(): Promise<void> {
    this.value = '';
    try {
      await request((await store('readwrite')).delete(KEY));
    } catch {
      // Nothing stored to delete.
    }
  }

  get held(): boolean {
    return this.value !== '';
  }
}
