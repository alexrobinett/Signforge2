/**
 * Pairing (docs/backend-plan.md#screens): a screen with no credential asks the API for a code,
 * shows it full screen and polls every 5 seconds until a member claims it (`claim_screen`). Then
 * the poll returns the screen's credential, once.
 *
 * The code is the only thing on a dark screen, possibly for days, and the panel may be OLED: it
 * moves to a new place every minute.
 */
import {
  parsePairPollResponse,
  parsePairStartResponse,
  type PairStartRequest,
  type PairStartResponse,
  type Parsed,
  type ScreenKind,
} from '@signforge/contract';

const POLL_MS = 5000;

export interface PairingOptions {
  /** The API's device base, `https://<api>/v1/device`. */
  base: string;
  /** What this screen is, so the claim makes a screen of that kind. */
  kind: ScreenKind;
  /** How often the code moves (testing shortens it). */
  moveMs?: number;
  /** Checked before each poll: true stops pairing (a credential turned up another way). */
  stop: () => Promise<boolean>;
  /** The code now on screen, or '' once it is gone. */
  onCode: (code: string) => void;
}

class RateLimited extends Error {
  constructor(readonly waitMs: number) {
    super('pairing: rate limited');
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function post<T>(url: string, body: unknown, parse: (r: unknown) => Parsed<T>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    // Never a cookie: on the CMS's hostname the API sits beside a user's session, and refuses it.
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) throw new RateLimited((Number(res.headers.get('retry-after')) || 60) * 1000);
  if (!res.ok) throw new Error(`pairing: HTTP ${res.status}`);
  const parsed = parse(await res.json());
  if (!parsed.ok) throw new Error(`pairing: ${parsed.problems.join('; ')}`);
  return parsed.value;
}

/**
 * Pair the screen. Resolves with its credential, or undefined if `stop` said to. Errors and rate
 * limits are waited out; an expired code is replaced with a new one.
 */
export async function pair(opts: PairingOptions): Promise<string | undefined> {
  const view = new CodeView(opts.moveMs ?? 60_000);
  try {
    let start: PairStartResponse | undefined;
    for (;;) {
      if (await opts.stop()) return undefined;
      try {
        if (!start) {
          start = await post(`${opts.base}/pair/start`, { kind: opts.kind } satisfies PairStartRequest, parsePairStartResponse);
          view.show(start.code);
          opts.onCode(start.code);
        }
        const r = await post(`${opts.base}/pair/poll`, { pollToken: start.pollToken }, parsePairPollResponse);
        if (r.status === 'paired') return r.credential;
        if (r.status === 'expired') {
          start = undefined;
          continue;
        }
      } catch (err) {
        console.warn('[sf] pairing:', err instanceof Error ? err.message : String(err));
        if (err instanceof RateLimited) await sleep(err.waitMs);
      }
      await sleep(POLL_MS);
    }
  } finally {
    view.hide();
    opts.onCode('');
  }
}

/** The code, full screen, moving every `moveMs` so no pixel stays lit in one place. */
class CodeView {
  private readonly el: HTMLElement;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly moveMs: number) {
    this.el = document.getElementById('pair') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pair' }));
  }

  show(code: string): void {
    const spaced = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
    this.el.replaceChildren(Object.assign(document.createElement('div'), { className: 'card' }));
    const card = this.el.firstElementChild!;
    card.append(
      Object.assign(document.createElement('div'), { className: 'title', textContent: 'Pair this screen' }),
      Object.assign(document.createElement('div'), { className: 'code', textContent: spaced }),
      Object.assign(document.createElement('div'), { className: 'hint', textContent: 'Enter this code in SignForge to add the screen' }),
    );
    this.el.style.display = 'block';
    this.move();
    this.timer ??= setInterval(() => this.move(), this.moveMs);
  }

  hide(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.el.style.display = 'none';
    this.el.replaceChildren();
  }

  /** A random place that keeps the card on screen. */
  private move(): void {
    const card = this.el.firstElementChild as HTMLElement | null;
    if (!card) return;
    const x = 10 + Math.random() * 80;
    const y = 15 + Math.random() * 70;
    card.style.left = `${x}%`;
    card.style.top = `${y}%`;
    card.style.transform = `translate(-${x}%, -${y}%)`;
  }
}
