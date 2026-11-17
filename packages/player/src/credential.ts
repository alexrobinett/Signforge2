/**
 * The screen's device credential, for a player whose content base is the API.
 *
 * The device supervisor holds it in a 0600 file and hands it over loopback, only to the player's
 * own origin, the same way it hands over its token. It never goes in the URL: a template frame can
 * read its parent's address. It is sent as a bearer header on every device request.
 */
export class DeviceCredential {
  private value = '';

  constructor(
    private readonly supervisor: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** Headers for a device request. Empty while the supervisor has no credential to give. */
  async headers(): Promise<Record<string, string>> {
    if (!this.value) {
      try {
        const res = await this.fetchImpl(`${this.supervisor}/credential`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (res.ok) this.value = ((await res.json()) as { credential?: string }).credential ?? '';
      } catch {
        // No supervisor (a browser, the demo): requests go without one and the server says 401.
      }
    }
    return this.value ? { authorization: `Bearer ${this.value}` } : {};
  }

  /** The server refused it. Collect it again next time, in case a new one was installed. */
  forget(): void {
    this.value = '';
  }

  get held(): boolean {
    return this.value !== '';
  }
}
