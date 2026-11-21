/**
 * `FieldForm` (docs/proposals/cms-ui.md): a template's fields as a form, in the order the template
 * lists them: text, number, boolean, colour (a brand colour or a custom one), select, url (an https
 * address), image (the asset picker) and list (repeating rows, up to `maxItems`). The contract's
 * message for a field (`validateSpotData`) sits under it. Values a spot leaves out show the
 * template's default.
 */
import { BRAND_COLORS, type FieldDef, type ScalarFieldDef, sessionBlobPath } from '@signforge/contract';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { AssetPicker } from '~/components/assets/asset-picker';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import type { AssetView } from '~/lib/assets';
import { fieldProblems, startValue, type SpotDraft } from '~/lib/spots';
import { useAppStore } from '~/state/provider';

/** A change to the draft, as the editor's `editSpot` takes it. */
type Edit = (change: (d: SpotDraft) => SpotDraft) => void;

const BRAND_WORD: Record<string, string> = {
  primary: 'Brand primary',
  onPrimary: 'Brand on primary',
  accent: 'Brand accent',
  onAccent: 'Brand on accent',
  background: 'Brand background',
  surface: 'Brand surface',
  text: 'Brand text',
  muted: 'Brand muted',
};

const fieldClass = 'flex flex-col gap-1.5';

function Problems({ id, problems }: { id: string; problems: string[] | undefined }) {
  if (!problems?.length) return null;
  return (
    <p id={id} className="text-sm font-medium text-destructive">
      {problems.join(' ')}
    </p>
  );
}

/** One scalar field's control. `value` is what the spot holds, or the default. */
function ScalarInput({
  id,
  def,
  value,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  def: ScalarFieldDef;
  value: unknown;
  invalid: boolean;
  describedBy?: string;
  onChange: (v: unknown) => void;
}) {
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy };
  switch (def.type) {
    case 'text':
      return <Input id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} {...aria} />;
    case 'url':
      return (
        <Input
          id={id}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
      );
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={def.min}
          max={def.max}
          step={def.step ?? 'any'}
          value={typeof value === 'number' || typeof value === 'string' ? value : ''}
          // A box left empty keeps its text, so the contract says it must be a number.
          onChange={(e) => onChange(Number.isNaN(e.target.valueAsNumber) ? e.target.value : e.target.valueAsNumber)}
          className="max-w-40 font-mono"
          {...aria}
        />
      );
    case 'boolean':
      return (
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="size-5 accent-primary" {...aria} />
      );
    case 'select':
      return (
        <NativeSelect id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className="w-full" {...aria}>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </NativeSelect>
      );
    case 'color': {
      const text = typeof value === 'string' ? value : '';
      const brand = text.startsWith('$brand.') ? text : '';
      return (
        <span className="flex flex-wrap items-center gap-2">
          <NativeSelect
            id={id}
            value={brand}
            onChange={(e) => onChange(e.target.value || (/^#[0-9a-f]{6}$/i.test(text) ? text : '#ffffff'))}
            className="min-w-44 flex-1"
            {...aria}
          >
            {BRAND_COLORS.map((c) => (
              <option key={c} value={`$brand.${c}`}>
                {BRAND_WORD[c]}
              </option>
            ))}
            <option value="">Custom colour</option>
          </NativeSelect>
          {!brand && (
            <input
              type="color"
              aria-label={`${def.label}: custom colour`}
              value={/^#[0-9a-f]{6}$/i.test(text) ? text : '#ffffff'}
              onChange={(e) => onChange(e.target.value)}
              className="h-10 w-14 rounded-lg border border-input bg-card"
            />
          )}
        </span>
      );
    }
  }
}

function ImageField({
  name,
  def,
  assetId,
  assets,
  problems,
  onChange,
}: {
  name: string;
  def: Extract<FieldDef, { type: 'image' }>;
  assetId: string | undefined;
  assets: AssetView[];
  problems: string[] | undefined;
  onChange: Edit;
}) {
  const picking = useAppStore((s) => s.spotEditor.picking === name);
  const pick = useAppStore((s) => s.pickImageFor);
  const asset = assets.find((a) => a.id === assetId);
  const errorId = `field-${name}-error`;
  return (
    <div className={fieldClass}>
      <span className="font-medium" id={`field-${name}-label`}>
        {def.label}
      </span>
      <div className="flex items-center gap-3">
        <div className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-md bg-[#0e0f12]">
          {asset && <img src={sessionBlobPath(asset.sha256)} alt="" className="size-full object-cover" />}
        </div>
        <span className="min-w-0 flex-1 truncate text-sm">{asset ? asset.name : 'No image chosen'}</span>
        <Button type="button" variant="outline" onClick={() => pick(name)} aria-describedby={problems ? errorId : undefined}>
          {asset ? 'Replace' : 'Choose image'}
          <span className="sr-only"> for {def.label}</span>
        </Button>
      </div>
      <Problems id={errorId} problems={problems} />
      <AssetPicker
        assets={assets}
        open={picking}
        onOpenChange={(o) => pick(o ? name : null)}
        onPick={(a) => onChange((d) => ({ ...d, assets: { ...d.assets, [name]: a.id } }))}
      />
    </div>
  );
}

function ListField({
  name,
  def,
  rows,
  problems,
  onChange,
}: {
  name: string;
  def: Extract<FieldDef, { type: 'list' }>;
  rows: Record<string, unknown>[];
  problems: string[] | undefined;
  onChange: Edit;
}) {
  const setRows = (next: Record<string, unknown>[]) => onChange((d) => ({ ...d, data: { ...d.data, [name]: next } }));
  const full = def.maxItems !== undefined && rows.length >= def.maxItems;
  const blank = Object.fromEntries(Object.entries(def.item).map(([k, d]) => [k, startValue(d)]));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1.5 font-medium">
        {def.label}
        {def.maxItems !== undefined && (
          <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
            {rows.length}/{def.maxItems}
          </span>
        )}
      </legend>
      {rows.map((row, i) => (
        // Rows have no ids of their own; their place is who they are.
        // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position in the list.
        <div key={i} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Row {i + 1}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove row ${i + 1} of ${def.label}`}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </div>
          {Object.entries(def.item).map(([k, d]) => {
            const id = `field-${name}-${i}-${k}`;
            return (
              <div key={k} className={d.type === 'boolean' ? 'flex items-center gap-2' : fieldClass}>
                <label htmlFor={id} className="text-sm">
                  {d.label}
                </label>
                <ScalarInput
                  id={id}
                  def={d}
                  value={row[k] ?? d.default}
                  invalid={false}
                  onChange={(v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))}
                />
              </div>
            );
          })}
        </div>
      ))}
      <Button type="button" variant="outline" className="self-start" disabled={full} onClick={() => setRows([...rows, blank])}>
        <PlusIcon aria-hidden />
        Add a row
      </Button>
      <Problems id={`field-${name}-error`} problems={problems} />
    </fieldset>
  );
}

export function FieldForm({ fields, draft, assets, onChange }: { fields: Record<string, FieldDef>; draft: SpotDraft; assets: AssetView[]; onChange: Edit }) {
  const problems = fieldProblems(fields, draft);
  return (
    <div className="flex flex-col gap-5">
      {Object.entries(fields).map(([name, def]) => {
        const p = problems.get(name);
        if (def.type === 'image')
          return <ImageField key={name} name={name} def={def} assetId={draft.assets[name]} assets={assets} problems={p} onChange={onChange} />;
        const value = draft.data[name] ?? def.default;
        if (def.type === 'list') {
          const rows = Array.isArray(value) ? value.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null) : [];
          return <ListField key={name} name={name} def={def} rows={rows} problems={p} onChange={onChange} />;
        }
        const id = `field-${name}`;
        const errorId = `${id}-error`;
        const set = (v: unknown) => onChange((d) => ({ ...d, data: { ...d.data, [name]: v } }));
        return (
          <div key={name} className={def.type === 'boolean' ? 'flex flex-wrap items-center gap-x-3 gap-y-1.5' : fieldClass}>
            <span className="flex justify-between gap-2">
              <label htmlFor={id} className="font-medium">
                {def.label}
              </label>
              {def.type === 'text' && def.maxLength !== undefined && (
                <span className={p ? 'font-mono text-xs font-semibold text-destructive' : 'font-mono text-xs text-muted-foreground'}>
                  {typeof value === 'string' ? value.length : 0}/{def.maxLength}
                </span>
              )}
            </span>
            <ScalarInput id={id} def={def} value={value} invalid={p !== undefined} describedBy={p ? errorId : undefined} onChange={set} />
            <Problems id={errorId} problems={p} />
          </div>
        );
      })}
    </div>
  );
}
