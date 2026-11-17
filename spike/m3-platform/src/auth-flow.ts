/**
 * The organization flow the CMS needs, end to end on D1: two users sign in by email code, one
 * creates an org, invites the other as an editor, the other accepts, and both are members.
 */
import { createAuth, type Mailbox } from './auth';

export async function runAuthFlow(env: { DB: D1Database }, baseURL: string) {
  const mailbox: Mailbox = new Map();
  const auth = createAuth(env, baseURL, mailbox);
  const run = Date.now().toString(36);
  const owner = `owner-${run}@spike.test`;
  const editor = `editor-${run}@spike.test`;
  const steps: string[] = [];

  // Replace cookies the way a browser would when a response sets new ones.
  const merge = (h: Headers, setCookies: string[]) => {
    const jar = new Map(h.get('cookie')!.split('; ').map((c) => [c.split('=')[0]!, c] as const));
    for (const c of setCookies) jar.set(c.split('=')[0]!, c.split(';')[0]!);
    return new Headers({ cookie: [...jar.values()].join('; ') });
  };

  const signIn = async (email: string) => {
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
    const otp = mailbox.get(email);
    if (!otp) throw new Error('no OTP captured');
    const { headers } = await auth.api.signInEmailOTP({ body: { email, otp }, returnHeaders: true });
    const cookie = headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    steps.push(`signed in ${email}`);
    return new Headers({ cookie });
  };

  const ownerH = await signIn(owner);
  const org = await auth.api.createOrganization({ body: { name: `Spike ${run}`, slug: `spike-${run}` }, headers: ownerH });
  if (!org) throw new Error('createOrganization returned nothing');
  steps.push(`created org ${org.id}`);
  const invite = await auth.api.createInvitation({ body: { email: editor, role: 'editor', organizationId: org.id }, headers: ownerH });
  steps.push(`invited ${editor} as ${invite.role}; invitation email hook got ${mailbox.get(`invite:${editor}`) === invite.id}`);
  const editorH = await signIn(editor);
  const accepted = await auth.api.acceptInvitation({ body: { invitationId: invite.id }, headers: editorH });
  steps.push(`accepted: member ${accepted?.member.id} role ${accepted?.member.role}`);
  // With the session cookie cache on, the old cache cookie still says "no active org" until the
  // client takes the cookies setActiveOrganization returns.
  const active = await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: editorH, returnHeaders: true });
  const editorH2 = merge(editorH, active.headers.getSetCookie());
  const allowed = await auth.api.hasPermission({ body: { permissions: { content: ['publish'] } }, headers: editorH2 });
  const viewerCheck = await auth.api.hasPermission({ body: { permissions: { organization: ['delete'] } }, headers: editorH2 });
  steps.push(`editor may delete the org: ${viewerCheck.success}`);
  steps.push(`editor may publish: ${allowed.success}`);
  const members = await auth.api.listMembers({ query: { organizationId: org.id }, headers: ownerH });
  const roles = members.members.map((m) => `${m.user.email}:${m.role}`).sort();
  steps.push(`members: ${roles.join(', ')}`);
  return { ok: members.members.length === 2 && accepted?.member.role === 'editor', steps };
}
