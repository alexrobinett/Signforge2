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
    <div className="flex min-h-dvh flex-col bg-card md:flex-row">
      <RenderWall />
      <main className="flex min-w-0 flex-[1_1_26rem] flex-col justify-between gap-10 px-5 py-8 sm:px-[clamp(1.25rem,6vw,5.5rem)] sm:py-10">
        <Logo />
        <div className="w-full max-w-[25rem]">
          <SignInForm options={options} next={next} />
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">New here? Signing in creates your account, and then your organization.</p>
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
      <div className="space-y-7">
        <div className="space-y-2">
          {/* Focused on arrival, so a screen reader announces the new step. */}
          <h1 ref={focusOnMount} tabIndex={-1} className="text-[34px] leading-[1.15] font-semibold tracking-tight outline-none">
            Check your email
          </h1>
          <p className="text-base leading-normal text-muted-foreground">
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
              className="h-16 px-4 font-mono text-[32px] tracking-[0.5em] md:text-[32px]"
            />
          </div>
          <FormMessages error={error} errorId={errorId} notice={notice} />
          <Button type="submit" size="lg" className="h-12 w-full text-base font-semibold" disabled={code.length !== 6 || pending !== null}>
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
    <div className="space-y-7">
      <div className="space-y-2">
        <h1 className="text-[34px] leading-[1.15] font-semibold tracking-tight">Sign in to SignForge</h1>
        <p className="text-base leading-normal text-muted-foreground">We will email you a 6-digit code. No password to remember.</p>
      </div>
      <form onSubmit={onEmailSubmit} className="space-y-7" noValidate>
        <div className="space-y-2">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            name="email"
            type="email"
            value={email}
            onChange={(e) => editEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@yourbusiness.com"
            required
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className="h-12 text-base md:text-base"
          />
        </div>
        <FormMessages error={error} errorId={errorId} notice={null} />
        <div className="space-y-3">
          <Button type="submit" size="lg" className="h-12 w-full text-base font-semibold" disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || pending !== null}>
            {pending === 'send' ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <MailIcon aria-hidden />}
            {pending === 'send' ? 'Sending code…' : 'Email me a code'}
          </Button>
          {options.github && (
            <>
              <div className="flex items-center gap-3 text-[13px] text-muted-foreground" aria-hidden>
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-12 w-full text-base"
                onClick={() => void signInWithGitHub(next)}
                disabled={pending !== null}
              >
                {pending === 'github' ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <GitHubMark className="size-5" />}
                Continue with GitHub
              </Button>
            </>
          )}
        </div>
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

/** Spots the SignForge player rendered (scripts/spot-shots.ts on examples/stress), tilted into a wall. */
const WALL: { src: string; alt: string }[][] = [
  [
    { src: 'sport-drinks-1080x1920', alt: 'Sport drinks 2 for $4 promo, portrait' },
    { src: 'clock-1920x1080', alt: 'Clock spot' },
    { src: 'weather-rain-1920x1080', alt: 'Weather spot, rain in Seattle' },
  ],
  [
    { src: 'energy-1920x1080', alt: 'Energy drinks 3 for $7 promo' },
    { src: 'menu-1080x1920', alt: 'Coffee bar menu board, portrait' },
    { src: 'meeting-room-1920x1080', alt: 'Room 4B bookings' },
  ],
  [
    { src: 'weather-live-1080x1920', alt: 'Atlanta weather, portrait' },
    { src: 'sport-drinks-1920x1080', alt: 'Sport drinks promo' },
    { src: 'weather-snow-1920x1080', alt: 'Weather spot, snow in Denver' },
  ],
];

/** The left half (the top on phones): what the product makes, drawn by the real player. */
function RenderWall() {
  return (
    <section
      aria-label="Spots rendered by the SignForge player"
      className="relative flex h-64 flex-col overflow-hidden bg-[#0e0f12] md:h-auto md:min-h-dvh md:flex-[1_1_35rem]"
    >
      <div className="-mt-10 grid flex-1 origin-[40%_30%] -rotate-[4deg] scale-[1.12] grid-cols-3 gap-3.5 px-3.5">
        {WALL.map((column, i) => (
          <div
            key={column[0]!.src}
            className={i === 0 ? 'flex flex-col gap-3.5 pt-[60px]' : i === 2 ? 'flex flex-col gap-3.5 pt-[120px]' : 'flex flex-col gap-3.5'}
          >
            {column.map((spot) => (
              <img key={spot.src} src={`/sign-in/${spot.src}.webp`} alt={spot.alt} className="block w-full rounded-[10px]" loading="eager" decoding="async" />
            ))}
          </div>
        ))}
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0e0f12f5] from-30% to-transparent px-6 pt-28 pb-6 text-[#ededef] sm:px-10 sm:pb-9">
        <p className="text-[13px] tracking-[0.08em] text-[#b4b6be] uppercase">Rendered by the SignForge player</p>
        <p className="mt-2 max-w-[30ch] text-lg leading-snug font-medium sm:text-[22px]">Every spot here is a template filled in by someone in the CMS.</p>
      </div>
    </section>
  );
}
