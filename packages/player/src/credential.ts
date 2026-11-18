/**
 * The screen's device credential, for a player whose content base is the API.
 *
 * The device supervisor holds it in a 0600 file and hands it over loopback, only to the player's
 * own origin, the same way it hands over its token. It never goes in the URL: a template frame can
 * read its parent's address. It is sent as a bearer header on every device request.
 *
 * It is bound to the device API base it was paired with, which the supervisor keeps beside it. The
 * player's address names the API (`?content=`), and anyone can open the player with another one,
 * so the credential is used only when the two are the same; otherwise it is never sent, and the
 * screen does not pair with the other API either, which would replace it.
 *
 * Pairing (src/pairing.ts) gives the screen a new one, which is stored with the supervisor; a
 * revoked one is deleted there. Without a supervisor a paired credential lasts until the page
 * reloads. A browser test screen keeps its own in the browser instead (src/browser-credential.ts).
 */

/** A request to the supervisor that needs its token (the player's `supervisorFetch`). */
export type SupervisorSend = (path: string, init: RequestInit) => Promise<Response>;

/**
 * What the player knows of its credential: one to send, none (the supervisor said so), one bound
 * to another API (or to none, stored before credentials were bound), or no word from a supervisor.
 */
export type CredentialState = 'held' | 'none' | 'elsewhere' | 'unknown';

/** What the player needs of a credential, wherever it is kept. */
export interface ScreenCredential {
  /** Collect the credential if none is held, and say what came of it. */
  check(): Promise<CredentialState>;
  /** Headers for a device request. Empty while there is no credential. */
  headers(): Promise<Record<string, string>>;
  /** A credential from pairing: used from now on, and kept. */
  adopt(credential: string): Promise<void>;
  /** The server refused the credential: drop it and delete what is kept. */
  revoke(): Promise<void>;
  readonly held: boolean;
}

export class DeviceCredential implements ScreenCredential {
  private value = '';
  /** Credentials the server refused: if the supervisor still has one, it is not used again. */
  private readonly refused = new Set<string>();
  /** A paired credential the supervisor has not taken yet. */
  private unsaved = false;
  /** When the last save was tried (`Date.now()`), so a missing supervisor is not asked on every request. */
  private triedSaveAt = 0;

  constructor(
    /** The device API base the player was opened with: the credential is sent only if it is bound to this one. */
    private readonly api: string,
    private readonly supervisor: string,
    private readonly send: SupervisorSend,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** Collect the credential from the supervisor if none is held, and say what came of it. */
  async check(): Promise<CredentialState> {
    if (this.value) {
      if (this.unsaved && Date.now() - this.triedSaveAt > 60_000) await this.save();
      return 'held';
    }
    try {
      const res = await this.fetchImpl(`${this.supervisor}/credential`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (res.status === 404) return 'none';
      if (!res.ok) return 'unknown';
      const { credential: got = '', api } = (await res.json()) as { credential?: string; api?: string | null };
      if (!got || this.refused.has(got)) return 'none';
      if (api !== this.api) return 'elsewhere';
      this.value = got;
      return 'held';
    } catch {
      // No supervisor (a browser, the demo), or not up yet.
      return 'unknown';
    }
  }

  /** Headers for a device request. Empty while there is no credential. */
  async headers(): Promise<Record<string, string>> {
    await this.check();
    return this.value ? { authorization: `Bearer ${this.value}` } : {};
  }

  /** A credential from pairing with this API: used from now on, and handed to the supervisor to keep with it (retried a minute later until it takes it). */
  async adopt(credential: string): Promise<void> {
    this.value = credential;
    this.unsaved = true;
    await this.save();
  }

  /** The server refused the credential: drop it, never use it again, and delete it from the supervisor. */
  async revoke(): Promise<void> {
    if (this.value) this.refused.add(this.value);
    this.value = '';
    this.unsaved = false;
    try {
      await this.send('/credential', { method: 'DELETE' });
    } catch {
      // No supervisor: nothing stored to delete. One that is down keeps it, and it is refused here.
    }
  }

  get held(): boolean {
    return this.value !== '';
  }

  private async save(): Promise<void> {
    this.triedSaveAt = Date.now();
    try {
      const res = await this.send('/credential', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: this.value, api: this.api }),
      });
      if (res.ok) this.unsaved = false;
    } catch {
      // Tried again at the next check.
    }
  }
}
