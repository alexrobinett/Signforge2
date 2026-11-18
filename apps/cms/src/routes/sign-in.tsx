import { createFileRoute, redirect } from '@tanstack/react-router';
import { ArrowLeftIcon, LoaderCircleIcon, MailIcon, TerminalIcon } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { GitHubMark, Logo } from '~/components/logo';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { safeRedirect } from '~/lib/paths';
import { getShell, getSignInOptions, type SignInOptions } from '~/server/shell.functions';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => (typeof search.redirect === 'string' ? { redirect: search.redirect } : {}),
  beforeLoad: async ({ search }) => {
    if (await getShell()) throw redirect({ href: safeRedirect(search.redirect) });
  },
  loader: () => getSignInOptions(),
  head: () => ({ meta: [{ title: 'Sign in · SignForge' }] }),
  component: SignInPage,
});

function SignInPage() {
  const options = Route.useLoaderData();
  const { redirect: target } = Route.useSearch();
  const next = safeRedirect(target);

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <BrandPanel />
      <main className="flex flex-col px-4 py-8 sm:px-8">
        <div className="lg:hidden">
          <Logo />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <SignInForm options={options} next={next} />
        </div>
        <p className="text-center text-xs text-muted-foreground">No password to remember. We email you a code each time.</p>
      </main>
    </div>
  );
}

/**
 * Focuses an element once, when it mounts. A stable function, so React calls it only on mount and
 * unmount; an inline ref callback would run, and steal focus, on every render.
 */
function focusOnMount(el: HTMLElement | null) {
  el?.focus();
}

/** The two steps of signing in. Every change goes through the store's sign-in actions (src/state/sign-in.ts). */
function SignInForm({ options, next }: { options: SignInOptions; next: string }) {
  const { step, email, code, pending, error, notice } = useAppStore((s) => s.signIn);
  const editEmail = useAppStore((s) => s.editEmail);
  const editCode = useAppStore((s) => s.editCode);
  const startSignIn = useAppStore((s) => s.startSignIn);
  const resendCode = useAppStore((s) => s.resendCode);
  const submitCode = useAppStore((s) => s.submitCode);
  const changeEmail = useAppStore((s) => s.changeEmail);
  const signInWithGitHub = useAppStore((s) => s.signInWithGitHub);
  const emailId = useId();
  const codeId = useId();
  const errorId = useId();

  function onEmailSubmit(e: SubmitEvent) {
    e.preventDefault();
    void startSignIn();
  }

  function onCodeSubmit(e: SubmitEvent) {
    e.preventDefault();
    void submitCode(next);
  }

  const describedBy = error ? errorId : undefined;

  if (step === 'code') {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          {/* Focused on arrival, so a screen reader announces the new step. */}
          <h1 ref={focusOnMount} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
            Check your email
          </h1>
          <p className="text-sm text-muted-foreground">
            We sent a 6-digit code to <span className="font-medium text-foreground">{email.trim()}</span>. It expires in 10 minutes.
          </p>
        </div>
        {options.codesInTerminal && <DevCodeHint />}
        <form onSubmit={onCodeSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor={codeId}>Sign-in code</Label>
            <Input
              id={codeId}
              name="code"
              value={code}
              onChange={(e) => editCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              className="h-12 text-center font-mono text-xl tracking-[0.5em] md:text-xl"
            />
          </div>
          <FormMessages error={error} errorId={errorId} notice={notice} />
          <Button type="submit" size="lg" className="w-full" disabled={code.length !== 6 || pending !== null}>
            {pending === 'verify' && <LoaderCircleIcon className="animate-spin" aria-hidden />}
            {pending === 'verify' ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Button variant="link" className="h-auto px-0" onClick={changeEmail}>
            <ArrowLeftIcon aria-hidden /> Use a different email
          </Button>
          <Button variant="link" className="h-auto px-0" onClick={() => void resendCode()} disabled={pending !== null}>
            {pending === 'send' ? 'Sending…' : 'Send a new code'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to SignForge</h1>
        <p className="text-sm text-muted-foreground">Enter your email and we will send you a sign-in code. New here? The same step creates your account.</p>
      </div>
      {options.github && (
        <>
          <Button variant="outline" size="lg" className="w-full" onClick={() => void signInWithGitHub(next)} disabled={pending !== null}>
            {pending === 'github' ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <GitHubMark className="size-4" />}
            Continue with GitHub
          </Button>
          <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      )}
      <form onSubmit={onEmailSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            name="email"
            type="email"
            value={email}
            onChange={(e) => editEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@company.com"
            required
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          />
        </div>
        <FormMessages error={error} errorId={errorId} notice={null} />
        <Button type="submit" size="lg" className="w-full" disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || pending !== null}>
          {pending === 'send' ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <MailIcon aria-hidden />}
          {pending === 'send' ? 'Sending code…' : 'Email me a code'}
        </Button>
      </form>
      {options.codesInTerminal && <DevCodeHint />}
    </div>
  );
}

function FormMessages({ error, errorId, notice }: { error: string | null; errorId: string; notice: string | null }) {
  return (
    <>
      <p id={errorId} role="alert" className="text-sm font-medium text-destructive empty:hidden">
        {error}
      </p>
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {notice}
      </p>
    </>
  );
}

/** Shown only when the API runs in dev, where codes are printed rather than emailed. */
function DevCodeHint() {
  return (
    <Alert variant="info">
      <TerminalIcon aria-hidden />
      <AlertTitle>Development</AlertTitle>
      <AlertDescription>
        <p>
          No email is sent. The code is printed in the terminal running the API (<code className="font-mono text-xs">pnpm --filter @signforge/api dev</code>).
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** The left half at desktop width: a picture of what the product does. Decorative. */
function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-[oklch(0.22_0.06_272)] p-10 text-white lg:flex lg:flex-col" aria-label="About SignForge">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,oklch(0.55_0.2_275/0.45),transparent_55%),radial-gradient(circle_at_90%_90%,oklch(0.6_0.15_200/0.3),transparent_50%)]" />
      <Logo inverse className="relative" />
      <div className="relative my-auto space-y-10">
        <div aria-hidden className="mx-auto w-full max-w-md">
          <div className="rounded-xl border border-white/15 bg-white/5 p-3 shadow-2xl backdrop-blur">
            <div className="grid aspect-video grid-cols-3 grid-rows-2 gap-2 rounded-lg bg-black/40 p-2">
              <div className="col-span-2 row-span-2 rounded-md bg-gradient-to-br from-indigo-400/80 to-cyan-300/70" />
              <div className="rounded-md bg-white/15" />
              <div className="rounded-md bg-white/10" />
            </div>
          </div>
          <div className="mx-auto h-6 w-2 bg-white/15" />
          <div className="mx-auto h-1.5 w-24 rounded-full bg-white/15" />
        </div>
        <div className="max-w-md space-y-3">
          <p className="text-2xl font-semibold tracking-tight">Every screen, on time, even offline.</p>
          <p className="text-white/75">Build spots and playlists, schedule them, and publish to every screen in your organization at once.</p>
        </div>
      </div>
    </aside>
  );
}
