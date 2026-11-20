/**
 * Your account (canvas board Account): profile, sign-in methods, where you are signed in, and the
 * CMS theme. It applies in every organization you belong to.
 */
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { EditorFields } from '~/components/editor';
import { PageHeader } from '~/components/page';
import { ActionError, SettingsSection } from '~/components/settings/parts';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { ago } from '~/lib/screen-status';
import { describeAgent } from '~/lib/settings';
import type { Theme } from '~/lib/theme';
import { cn } from '~/lib/utils';
import { backToPage } from '~/server/form-post.server';
import { getAccount } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/account')({
  server: { handlers: backToPage },
  loader: () => getAccount(),
  head: () => ({ meta: [{ title: 'Your account · SignForge' }] }),
  component: AccountPage,
});

const app = getRouteApi('/_app');

const THEMES: { value: Theme; label: string; icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
];

function AccountPage() {
  const { sessions, github, at } = Route.useLoaderData();
  const { user } = app.useLoaderData();
  const id = useId();
  const pending = useAppStore((s) => s.settings.pending);
  const saveProfile = useAppStore((s) => s.saveProfile);
  const signOutSession = useAppStore((s) => s.signOutSession);
  const signOutOtherSessions = useAppStore((s) => s.signOutOtherSessions);
  const connectGithub = useAppStore((s) => s.connectGithub);
  const theme = useAppStore((s) => s.ui.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const others = sessions.filter((s) => s.token !== null);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void saveProfile(String(new FormData(e.currentTarget).get('name') ?? ''));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Your account">
        <p className="text-sm text-muted-foreground">
          Applies everywhere you sign in.{' '}
          <Link to="/settings/general" className="text-primary underline underline-offset-4">
            Organization settings
          </Link>{' '}
          are separate.
        </p>
      </PageHeader>

      <SettingsSection id={`${id}-profile`} title="Profile">
        <form key={user.name} method="post" onSubmit={submit} className="grid max-w-md gap-4" noValidate>
          <EditorFields>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input id={`${id}-name`} name="name" defaultValue={user.name} maxLength={100} autoComplete="name" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-email`}>Email</Label>
              <Input id={`${id}-email`} value={user.email} readOnly aria-describedby={`${id}-email-help`} />
              <p id={`${id}-email-help`} className="text-[13px] text-muted-foreground">
                Your sign-in address. Changing it is not offered yet.
              </p>
            </div>
            <ActionError at="profile" />
            <div>
              <Button type="submit" disabled={pending === 'profile'}>
                Save
              </Button>
            </div>
          </EditorFields>
        </form>
      </SettingsSection>

      <SettingsSection id={`${id}-methods`} title="Sign-in methods" description="There are no passwords.">
        <ul className="divide-y">
          <li className="flex items-center gap-3 py-3">
            <span className="flex-1">
              <span className="block font-medium">Email code</span>
              <span className="block text-sm text-muted-foreground">{user.email}</span>
            </span>
            <span className="text-sm">On</span>
          </li>
          {github.offered && (
            <li className="flex flex-wrap items-center gap-3 py-3">
              <span className="flex-1">
                <span className="block font-medium">GitHub</span>
                <span className="block text-sm text-muted-foreground">{github.linked ? 'Connected' : 'Not connected'}</span>
              </span>
              {!github.linked && (
                <Button variant="outline" disabled={pending === 'github'} onClick={() => void connectGithub()}>
                  Connect GitHub
                </Button>
              )}
              <div className="basis-full empty:hidden">
                <ActionError at="github" />
              </div>
            </li>
          )}
        </ul>
      </SettingsSection>

      <SettingsSection id={`${id}-sessions`} title="Where you're signed in">
        <ul className="divide-y">
          {sessions.map((s) => (
            <li key={s.token ?? 'current'} className="flex flex-wrap items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{describeAgent(s.userAgent)}</span>
                <span className="block text-sm text-muted-foreground">
                  {[s.ipAddress, s.token === null ? 'This browser' : `active ${ago(at - Date.parse(s.updatedAt))} ago`].filter(Boolean).join(' · ')}
                </span>
              </span>
              {s.token !== null && (
                <Button variant="ghost" size="sm" disabled={pending === `session:${s.token}`} onClick={() => s.token && void signOutSession(s.token)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
        {others.length > 0 && (
          <div className="space-y-2">
            <ActionError at="sessions" />
            <Button variant="outline" disabled={pending === 'sessions'} onClick={() => void signOutOtherSessions()}>
              Sign out everywhere else
            </Button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection id={`${id}-theme`} title="Theme" description="For the CMS only. Screens follow their brand kit.">
        <fieldset>
          <legend className="sr-only">Theme</legend>
          <div className="flex flex-wrap gap-2">
            <EditorFields>
              {THEMES.map(({ value, label, icon: Icon }) => (
                <label
                  key={value}
                  className={cn(
                    'flex h-10 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                    theme === value ? 'border-foreground bg-foreground text-background' : 'border-border-strong bg-card hover:bg-accent',
                  )}
                >
                  <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => setTheme(value)} className="sr-only" />
                  <Icon className="size-4" aria-hidden /> {label}
                </label>
              ))}
            </EditorFields>
          </div>
        </fieldset>
      </SettingsSection>
    </div>
  );
}
