import { useParams } from '@tanstack/react-router';
import { ArrowLeftIcon, CornerDownLeftIcon, LoaderCircleIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback } from 'react';
import { Button } from '~/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '~/components/ui/command';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { commandEntries, NULL_CHOICE, type CommandEntry, type Field, type ToolListing } from '~/lib/command-menu';
import { SECTIONS } from '~/lib/sections';
import { useAppStore } from '~/state/provider';

const FIELD =
  'flex w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm';

const Mono = ({ children, className = '' }: { children: string; className?: string }) => (
  <span className={`shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground ${className}`}>{children}</span>
);

/** The form's first field takes focus when the form appears. Stable, so it runs once per form. */
const focusFirstField = (form: HTMLFormElement | null) => form?.querySelector<HTMLElement>('input, select, textarea')?.focus();

function FieldInput({
  field,
  id,
  defaultValue,
  invalid,
  ref,
}: {
  field: Field;
  id: string;
  defaultValue: string | undefined;
  invalid: boolean;
  ref: ((el: HTMLElement | null) => void) | undefined;
}) {
  const common = {
    ref,
    id,
    name: field.name,
    required: field.required && !field.nullable,
    defaultValue,
    'aria-invalid': invalid || undefined,
    'aria-describedby': `${id}-hint`,
  };
  switch (field.type) {
    case 'key':
      return null;
    case 'boolean':
      return <input type="checkbox" {...common} className="size-4.5 accent-primary" />;
    case 'choice':
      return (
        <select {...common} className={`${FIELD} h-10`}>
          {!field.required && <option value="">Not set</option>}
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          {field.nullable && <option value={NULL_CHOICE}>null</option>}
        </select>
      );
    case 'json':
      return <textarea {...common} rows={3} spellCheck={false} className={`${FIELD} font-mono`} />;
    case 'integer':
    case 'number':
      return <Input {...common} type="number" step={field.type === 'integer' ? 1 : 'any'} />;
    case 'text':
      return <Input {...common} autoComplete="off" spellCheck={false} />;
  }
}

/** A picked tool's form: one field per input, from its JSON Schema. */
function ToolForm({ entry }: { entry: Extract<CommandEntry, { kind: 'tool' }> }) {
  const running = useAppStore((s) => s.commandMenu.running);
  const fieldError = useAppStore((s) => s.commandMenu.fieldError);
  const back = useAppStore((s) => s.backToCommands);
  const submit = useAppStore((s) => s.submitToolForm);
  // The page's own ids fill the fields of the same name: on a screen's page, its screenId.
  const params: Record<string, string | undefined> = useParams({ strict: false });
  const { tool } = entry;
  // Each refusal moves focus to its field, which then reads out its error (its description): from
  // Run, a keyboard or screen-reader user would miss both. A new error is a new ref, so React calls it again.
  const focusInvalid = useCallback((el: HTMLElement | null) => (fieldError ? el?.focus() : undefined), [fieldError]);

  return (
    <form
      ref={focusFirstField}
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(entry.label, tool, new FormData(e.currentTarget));
      }}
    >
      <div className="flex items-center gap-2 border-b py-2.5 pr-4 pl-2">
        <Button type="button" variant="ghost" size="icon" onClick={back} aria-label="Back to commands">
          <ArrowLeftIcon className="size-4.5" aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3">
          <h3 className="line-clamp-2 flex-1 text-base font-semibold">{entry.label}</h3>
          <Mono>{tool.name}</Mono>
        </div>
      </div>
      <div className="max-h-[min(470px,60dvh)] space-y-4 overflow-y-auto px-4 py-4">
        <p className="text-sm text-muted-foreground">{tool.description}</p>
        {tool.fields
          .filter((f) => f.type !== 'key')
          .map((f) => {
            const id = `cmd-field-${f.name}`;
            const error = fieldError?.field === f.name ? fieldError.message : null;
            return (
              <div key={f.name} className={f.type === 'boolean' ? 'flex flex-row-reverse items-center justify-end gap-2.5' : 'space-y-1.5'}>
                <Label htmlFor={id} className="font-mono text-xs">
                  {f.name}
                  {f.required ? '' : ' (optional)'}
                </Label>
                <FieldInput field={f} id={id} defaultValue={params[f.name]} invalid={error !== null} ref={error === null ? undefined : focusInvalid} />
                <p id={`${id}-hint`} className={error ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground empty:hidden'}>
                  {error ?? f.hint}
                </p>
              </div>
            );
          })}
      </div>
      <div className="flex items-center justify-end gap-2 border-t bg-muted/50 px-4 py-3">
        <Button type="button" variant="ghost" onClick={back}>
          Back
        </Button>
        <Button type="submit" disabled={running}>
          {running && <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />}
          Run
        </Button>
      </div>
    </form>
  );
}

/**
 * ⌘K: go to any section, or run any tool the member's role allows, from every signed-in page.
 * The entries are the tool registry agents call (src/lib/command-menu.ts). It opens with no motion.
 */
export function CommandMenu({ tools }: { tools: ToolListing[] }) {
  const open = useAppStore((s) => s.commandMenu.open);
  const form = useAppStore((s) => s.commandMenu.form);
  const running = useAppStore((s) => s.commandMenu.running);
  const openMenu = useAppStore((s) => s.openCommandMenu);
  const close = useAppStore((s) => s.closeCommandMenu);
  const choose = useAppStore((s) => s.chooseCommand);

  const entries = commandEntries(tools);
  const picked = entries.find((e) => e.kind === 'tool' && e.tool.name === form);
  const go = entries.filter((e) => e.kind === 'go');
  const actions = entries.filter((e) => e.kind === 'tool');
  const icon = (to: string) => SECTIONS.find((s) => s.to === to)?.icon;

  const item = (e: CommandEntry) => {
    const Icon = e.kind === 'go' ? icon(e.to) : undefined;
    return (
      <CommandItem key={e.id} value={e.id} keywords={[e.label, ...e.keywords]} disabled={running} onSelect={() => void choose(e)}>
        {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
        <span className="line-clamp-2 min-w-0 flex-1 sm:truncate">{e.label}</span>
        {e.kind === 'tool' && <Mono className="hidden sm:inline">{e.tool.name}</Mono>}
      </CommandItem>
    );
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? openMenu() : close())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70" />
        <DialogPrimitive.Content className="fixed top-[12dvh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none dark:border-border-strong">
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Go to a page, or run an action. Type to filter; Enter runs the selected one.
          </DialogPrimitive.Description>
          {picked?.kind === 'tool' ? (
            <ToolForm key={picked.id} entry={picked} />
          ) : (
            <Command label="Search pages and actions" loop>
              <CommandInput placeholder="Go to a page, or type an action">
                <kbd className="rounded-md border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">esc</kbd>
              </CommandInput>
              <CommandList>
                <CommandEmpty>No page or action matches. Try a verb like “rename” or “restart”.</CommandEmpty>
                <CommandGroup heading="Go to">{go.map(item)}</CommandGroup>
                {actions.length > 0 && <CommandGroup heading="Actions">{actions.map(item)}</CommandGroup>}
              </CommandList>
              <p className="flex items-center gap-2 border-t bg-muted/50 px-4 py-3 text-[13px] text-muted-foreground">
                <CornerDownLeftIcon className="size-3.5 shrink-0" aria-hidden />
                These actions are the tool registry: the same names and roles agents call. The audit log records them by name.
              </p>
            </Command>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
