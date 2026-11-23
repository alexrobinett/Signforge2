/**
 * Settings, AI & agents (canvas board Settings-AI, #261, #262): the model the org's built-in agent
 * uses. With no key of its own the org uses SignForge's demo model; an owner saves, tests and removes
 * a key for Anthropic or an OpenAI-compatible endpoint (its https address, and whether it takes images
 * and returns JSON-schema output), chooses the fast and capable models from the provider's own list,
 * and sets a daily ceiling of turns. Everyone else reads it, never the key (docs/proposals/cms-agent.md).
 */
import { createFileRoute } from '@tanstack/react-router';
import { KeyRoundIcon, LoaderCircleIcon, PlugZapIcon } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { EditorFields } from '~/components/editor';
import { PageHeader } from '~/components/page';
import { ActionError, SettingsSection, useRunning } from '~/components/settings/parts';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import { useOrgId, useRole } from '~/lib/live';
import type { AiProvider } from '~/lib/settings';
import { backToPage } from '~/server/form-post.server';
import { getAiSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';
import type { SettingsScope } from '~/state/settings';

export const Route = createFileRoute('/_app/settings/ai')({
  server: { handlers: backToPage },
  loader: () => getAiSettings(),
  head: () => ({ meta: [{ title: 'AI & agents · SignForge' }] }),
  component: AiSettings,
});

const pageOf = (orgId: string): SettingsScope => ({ page: 'ai', orgId });

const day = (at: number) => new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

function AiSettings() {
  const data = Route.useLoaderData();
  const canEdit = useRole() === 'owner';
  const id = useId();
  if (!data) return null;
  const { provider, names } = data;
  return (
    <div className="space-y-6">
      <PageHeader title="AI & agents" description="The model behind the agent that fills spots from a flyer, a photo or a link." />
      <SettingsSection
        id={`${id}-provider`}
        title="Provider & quota"
        description={
          provider
            ? 'The agent uses your own key. Your provider bills you; SignForge adds nothing.'
            : 'No key of your own yet: the agent uses SignForge’s demo model, with a daily limit.'
        }
      >
        {provider ? <Provider provider={provider} savedBy={names[provider.keySavedBy] ?? 'a former member'} canEdit={canEdit} /> : null}
        {canEdit ? <KeyForm provider={provider} /> : !provider && <p className="text-sm text-muted-foreground">Only an owner can add a key.</p>}
      </SettingsSection>
      {provider && <Choices provider={provider} canEdit={canEdit} />}
    </div>
  );
}

/** The saved key, by its last four characters, who saved it and whether a test reached the provider with it. */
function Provider({ provider, savedBy, canEdit }: { provider: AiProvider; savedBy: string; canEdit: boolean }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">Provider</dt>
      <dd>
        <span className="font-medium">{provider.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible endpoint'}</span>
        {provider.baseUrl && <span className="block font-mono text-xs break-all text-muted-foreground">{provider.baseUrl}</span>}
      </dd>
      <dt className="text-muted-foreground">Supports</dt>
      <dd>
        <span>
          Images: {provider.supports.images ? 'yes' : 'no'} · JSON-schema output: {provider.supports.jsonSchema ? 'yes' : 'no'}
        </span>
        {!(provider.supports.images && provider.supports.jsonSchema) && (
          <span className="block text-muted-foreground">Fill from a flyer, photo or link needs both, so it does not run with this provider.</span>
        )}
      </dd>
      <dt className="text-muted-foreground">API key</dt>
      <dd>
        <span className="font-mono" aria-hidden>
          ••••••••{provider.keyLast4}
        </span>
        <span className="sr-only">ending in {provider.keyLast4}</span>
        <span className="block text-muted-foreground">
          Saved {day(provider.keySavedAt)} by {savedBy}. Stored encrypted; it never comes back to the browser.
        </span>
      </dd>
      <dt className="text-muted-foreground">Connection</dt>
      <dd className="flex flex-wrap items-center gap-2">
        {provider.verifiedAt ? (
          <span className="font-medium text-status-online-foreground">Connected, checked {day(provider.verifiedAt)}</span>
        ) : (
          <span className="text-muted-foreground">Not tested yet</span>
        )}
        {canEdit && <TestButton />}
      </dd>
    </dl>
  );
}

function TestButton() {
  const orgId = useOrgId();
  const test = useAppStore((s) => s.testAiProvider);
  const running = useRunning(pageOf(orgId));
  return (
    <>
      <Button type="button" variant="outline" aria-disabled={running !== undefined || undefined} onClick={() => void test(orgId)}>
        {running === 'test' ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <PlugZapIcon aria-hidden />} Test connection
      </Button>
      <ActionError at="test" />
    </>
  );
}

/**
 * Choose the provider and save its key, or replace or remove the saved one. The key field clears once
 * saved: the key is never shown again. The endpoint's fields show only while it is chosen, by CSS on
 * the radio, so the form keeps no state of its own; left empty, the saved key is kept.
 */
function KeyForm({ provider }: { provider: AiProvider | null }) {
  const orgId = useOrgId();
  const id = useId();
  const save = useAppStore((s) => s.saveAiKey);
  const running = useRunning(pageOf(orgId));
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const field = e.currentTarget.elements.namedItem('apiKey');
    const key = String(form.get('apiKey') ?? '');
    const chosen: AiProvider['provider'] = form.get('provider') === 'openai-compatible' ? 'openai-compatible' : 'anthropic';
    const fields = {
      provider: chosen,
      apiKey: key,
      baseUrl: String(form.get('baseUrl') ?? ''),
      acceptsImages: form.get('acceptsImages') === 'on',
      jsonSchemaOutput: form.get('jsonSchemaOutput') === 'on',
    };
    void save(orgId, fields, provider?.version).then((saved) => {
      if (saved && field instanceof HTMLInputElement && field.value === key) field.value = '';
    });
  };
  const current = provider?.provider ?? 'anthropic';
  return (
    <EditorFields>
      {/* Read afresh after each save: the radio and the endpoint's fields start from what is saved. */}
      <form key={provider?.version ?? 0} method="post" onSubmit={submit} className="group space-y-4" noValidate>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Provider</legend>
          <div className="flex flex-wrap gap-2">
            {(['anthropic', 'openai-compatible'] as const).map((p) => (
              <label key={p} className="flex h-10 items-center gap-2 rounded-lg border px-3 text-sm has-checked:border-primary has-checked:bg-accent">
                <input type="radio" name="provider" value={p} defaultChecked={current === p} className="accent-primary" />
                {p === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible endpoint'}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            OpenAI-compatible covers OpenAI, Gemini’s compatible endpoint and others. Its address must be public https: no private, loopback or metadata
            addresses.
          </p>
        </fieldset>
        <div className="hidden space-y-3 group-has-[input[value=openai-compatible]:checked]:block">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-base`}>Endpoint address</Label>
            <Input
              id={`${id}-base`}
              name="baseUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://api.openai.com/v1"
              defaultValue={provider?.baseUrl ?? ''}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Its base address: SignForge lists its models at this address followed by /models.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="acceptsImages" defaultChecked={provider?.provider === 'openai-compatible' && provider.supports.images} />
            Its models take images
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="jsonSchemaOutput" defaultChecked={provider?.provider === 'openai-compatible' && provider.supports.jsonSchema} />
            It returns output to a JSON schema (response_format json_schema)
          </label>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id}>{provider ? 'Replace the API key' : 'API key'}</Label>
          <Input id={id} name="apiKey" type="password" autoComplete="off" spellCheck={false} placeholder="sk-…" className="font-mono" />
          <p className="text-xs text-muted-foreground">
            Kept encrypted, and never shown again. Leave it empty to keep the saved key; a new provider or a new address needs the key again.
          </p>
        </div>
        <ActionError at="key" />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" aria-disabled={running !== undefined || undefined}>
            {running === 'key' ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <KeyRoundIcon aria-hidden />}{' '}
            {provider ? 'Save provider' : 'Save key'}
          </Button>
          {provider && <RemoveKey />}
        </div>
      </form>
    </EditorFields>
  );
}

/** Remove, then a second click to confirm: the key is deleted and the agent goes back to the demo model. */
function RemoveKey() {
  const orgId = useOrgId();
  const asking = useAppStore((s) => s.settings.removingAiKey === orgId);
  const ask = useAppStore((s) => s.askToRemoveAiKey);
  const remove = useAppStore((s) => s.removeAiKey);
  const running = useRunning(pageOf(orgId));
  const busy = running !== undefined;
  if (!asking)
    return (
      <Button type="button" variant="ghost" className="text-destructive" aria-disabled={busy || undefined} onClick={() => ask(orgId, true)}>
        Remove key
      </Button>
    );
  return (
    <div className="w-full space-y-2 rounded-lg border border-destructive/40 p-3 text-sm">
      <p>Remove the key? It is deleted, and the agent goes back to SignForge’s demo model and its daily limit.</p>
      <ActionError at="remove" />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="destructive" aria-disabled={busy || undefined} onClick={() => void remove(orgId)}>
          {running === 'remove' && <LoaderCircleIcon className="animate-spin" aria-hidden />} {running === 'remove' ? 'Removing…' : 'Remove'}
        </Button>
        <Button type="button" variant="outline" aria-disabled={busy || undefined} onClick={() => ask(orgId, false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

const MODELS = [
  { name: 'fastModel', label: 'Fast model', use: 'Fill from a flyer, photo or link' },
  { name: 'capableModel', label: 'Capable model', use: 'The agent’s drawer' },
] as const;

/** The models, chosen from the provider's own list (from the last test), and the daily ceiling. */
function Choices({ provider, canEdit }: { provider: AiProvider; canEdit: boolean }) {
  const orgId = useOrgId();
  const id = useId();
  const listed = useAppStore((s) => (s.settings.aiModels?.orgId === orgId ? s.settings.aiModels.models : null));
  const save = useAppStore((s) => s.saveAiChoices);
  const running = useRunning(pageOf(orgId));
  if (!canEdit)
    return (
      <SettingsSection id={`${id}-models`} title="Models and ceiling">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          {MODELS.map((m) => (
            <div key={m.name} className="contents">
              <dt className="text-muted-foreground">{m.label}</dt>
              <dd className="font-mono">{provider[m.name] ?? 'Not chosen'}</dd>
            </div>
          ))}
          <dt className="text-muted-foreground">Daily ceiling</dt>
          <dd>{provider.dailyTurnCeiling === null ? 'None' : `${provider.dailyTurnCeiling} agent turns a day`}</dd>
        </dl>
      </SettingsSection>
    );
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '');
    void save(
      orgId,
      provider.provider,
      { fastModel: value('fastModel'), capableModel: value('capableModel'), dailyTurnCeiling: value('dailyTurnCeiling') },
      provider.version,
    );
  };
  return (
    <SettingsSection
      id={`${id}-models`}
      title="Models and ceiling"
      description={
        listed
          ? `The models your key may use, as ${provider.provider === 'anthropic' ? 'Anthropic' : 'the endpoint'} lists them.`
          : 'Test the connection to list the models your key may use.'
      }
    >
      <EditorFields>
        {/* A new list or a new save shows afresh: the selects read what the page has now. */}
        <form key={`${provider.version}/${listed?.join() ?? ''}`} method="post" onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            {MODELS.map((m) => {
              const options = [...new Set([...(listed ?? []), ...(provider[m.name] ? [provider[m.name]!] : [])])];
              return (
                <div key={m.name} className="space-y-1.5">
                  <Label htmlFor={`${id}-${m.name}`}>{m.label}</Label>
                  <NativeSelect
                    id={`${id}-${m.name}`}
                    name={m.name}
                    defaultValue={provider[m.name] ?? ''}
                    className="w-full font-mono"
                    disabled={!options.length}
                  >
                    <option value="">Not chosen</option>
                    {options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </NativeSelect>
                  <p className="text-xs text-muted-foreground">{m.use}</p>
                </div>
              );
            })}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-ceiling`}>Daily ceiling for the whole organization</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id={`${id}-ceiling`}
                name="dailyTurnCeiling"
                type="number"
                inputMode="numeric"
                min={1}
                defaultValue={provider.dailyTurnCeiling ?? ''}
                className="w-28 font-mono"
              />
              <span className="text-sm text-muted-foreground">agent turns a day, then it pauses until midnight. Empty for none.</span>
            </div>
          </div>
          <ActionError at="choices" />
          <Button type="submit" aria-disabled={running !== undefined || undefined}>
            {running === 'choices' && <LoaderCircleIcon className="animate-spin" aria-hidden />} Save
          </Button>
        </form>
      </EditorFields>
    </SettingsSection>
  );
}
