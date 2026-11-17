/**
 * Outgoing email behind one small interface, so the provider can change without touching auth.
 *
 * - `CloudflareEmailSender`: Cloudflare Email Sending through the Worker's `send_email` binding.
 *   The default outside dev (owner decision Q3 is open; see docs/tickets/M3-09).
 * - `RecordingEmailSender`: keeps every message, so tests can read a sign-in code, and logs it,
 *   so a developer running `wrangler dev` sees the code in the terminal. Used in dev.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class RecordingEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];
  constructor(private readonly log = false) {}

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
    if (this.log) console.log(`[email] to ${message.to}: ${message.subject}\n${message.text}`);
  }

  /** The newest message to `to`, if any. */
  last(to: string): EmailMessage | undefined {
    return this.messages.findLast((m) => m.to === to);
  }
}

export class CloudflareEmailSender implements EmailSender {
  /** `from` must be an address on a domain onboarded to Email Sending. */
  constructor(
    private readonly binding: SendEmail,
    private readonly from: string,
  ) {}

  async send({ to, subject, text, html }: EmailMessage): Promise<void> {
    // Throws on a rejected send (unverified sender, suppressed recipient, quota); Better Auth turns it into a 500.
    await this.binding.send({ from: this.from, to, subject, text, ...(html ? { html } : {}) });
  }
}

/** One per isolate, so `wrangler dev` keeps a history; nothing depends on it surviving. */
const devOutbox = new RecordingEmailSender(true);

/** The sender for an environment: the recorder in dev, Cloudflare Email Sending elsewhere. */
export function emailSenderFor(env: Env): EmailSender {
  if (env.ENVIRONMENT === 'dev') return devOutbox;
  if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is not set');
  return new CloudflareEmailSender(env.EMAIL, env.EMAIL_FROM);
}
