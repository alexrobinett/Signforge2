/**
 * `FieldForm` (docs/proposals/cms-ui.md): a template's fields as a form, in the order the template
 * lists them: text, number, boolean, colour (a brand colour or a custom one), select, url (an https
 * address), date and datetime (the browser's pickers, held to `min` and `max`), image (the asset
 * picker) and list (repeating rows, up to `maxItems`). A field's problem (`validateSpotField`) sits
 * under it in words (src/lib/field-words.ts); an empty field's only once it is touched or Publish
 * was pressed (#359), so a spot just made is not a page of errors. A choice shows its option's label.
 * Values a spot leaves out show the template's default. A spot the agent just filled (#263) shows
 * its marks (./fill-marks.tsx) until each field is edited. A text or list still holding its
 * template's sample (#360: the server's `sampleFields`, from New spot until a saved edit) says so,
 * a list row by row; a sample text is selected when focused, so typing replaces it.
 */
import type { FieldMark } from '@signforge/api/agent-inline';
import { BRAND_COLORS, type FieldDef, type SampleFields, type ScalarFieldDef, sessionBlobPath } from '@signforge/contract';
import { startValue } from '@signforge/compiler/draft';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { AssetPicker } from '~/components/assets/asset-picker';
import { MarkNote, MarkPill } from '~/components/spots/fill-marks';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import type { AssetView } from '~/lib/assets';
import { isEmptyProblem, optionLabel, problemCell, problemWords } from '~/lib/field-words';
import { fieldProblems, type SpotDraft } from '~/lib/spots';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';

/** A change to the draft, as the editor's `editSpot` takes it. */
type Edit = (change: (d: SpotDraft) => SpotDraft) => void;

/** The photo a spot was filled from, offered for its image fields ("Use as the photo"). */
interface Flyer {
  onUse: (field: string) => void;
  uploading: boolean;
  error: string | null;
}

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

/** The mark on a field that still holds sample copy. */
function SampleNote({ id, rows }: { id: string; rows?: boolean }) {
  return (
    <p id={id} className="text-sm text-muted-foreground">
      {rows ? 'Sample rows. Replace them before you publish.' : 'Sample text. Replace it before you publish.'}
    </p>
  );
}

/**
 * A field's problems, in a live region that is always in the accessibility tree, so one that appears
 * (on leaving the field, #359) is announced: empty, it is only visually hidden, never removed.
 */
function Problems({ id, problems }: { id: string; problems: string[] | undefined }) {
  return (
    <p id={id} aria-live="polite" className={cn('text-sm font-medium text-destructive', !problems?.length && 'sr-only')}>
      {problems?.map((p) => `${p}.`).join(' ')}
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
  sample = false,
  onChange,
  onBlur,
}: {
  id: string;
  def: ScalarFieldDef;
  value: unknown;
  invalid: boolean;
  describedBy?: string;
  /** A text holding its sample: focusing it selects it all. */
  sample?: boolean;
  onChange: (v: unknown) => void;
  /** Left: the field is touched. */
  onBlur?: () => void;
}) {
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy, onBlur };
  switch (def.type) {
    case 'text':
      return (
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          onFocus={sample ? (e) => e.currentTarget.select() : undefined}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
      );
    case 'url':
      return (
        <Input
          id={id}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={typeof value === 'string' ? value : ''}
          // The contract refuses space around an address; the input drops it, as a url input's value does.
          onChange={(e) => onChange(e.target.value.trim())}
          {...aria}
        />
      );
    case 'date':
    case 'datetime':
      return (
        <Input
          id={id}
          // datetime-local gives the wall time the contract holds, YYYY-MM-DDTHH:mm, with no zone.
          type={def.type === 'date' ? 'date' : 'datetime-local'}
          min={def.min}
          max={def.max}
          value={typeof value === 'string' ? value : ''}
          // An unfinished entry is '', which the contract asks to be finished.
          onChange={(e) => onChange(e.target.value)}
          className="max-w-60 font-mono"
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
              {optionLabel(o)}
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
  mark,
  flyer,
  onChange,
  onTouch,
}: {
  name: string;
  def: Extract<FieldDef, { type: 'image' }>;
  assetId: string | undefined;
  assets: AssetView[];
  problems: string[] | undefined;
  mark: FieldMark | undefined;
  flyer: Flyer | undefined;
  onChange: Edit;
  onTouch: () => void;
}) {
  const picking = useAppStore((s) => s.spotEditor.picking === name);
  const pick = useAppStore((s) => s.pickImageFor);
  const asset = assets.find((a) => a.id === assetId);
  const errorId = `field-${name}-error`;
  return (
    <div className={fieldClass}>
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium" id={`field-${name}-label`}>
          {def.label}
        </span>
        {mark && <MarkPill mark={mark} />}
      </span>
      <div className="flex items-center gap-3">
        <div className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-md bg-[#0e0f12]">
          {asset && <img src={sessionBlobPath(asset.sha256)} alt="" className="size-full object-cover" />}
        </div>
        <span className="min-w-0 flex-1 truncate text-sm">{asset ? asset.name : 'No image chosen'}</span>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            onTouch();
            pick(name);
          }}
          aria-describedby={problems ? errorId : undefined}
        >
          {asset ? 'Replace' : 'Choose image'}
          <span className="sr-only"> for {def.label}</span>
        </Button>
      </div>
      {mark && <MarkNote id={`field-${name}-mark`} mark={mark} />}
      {mark && flyer && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={flyer.uploading} onClick={() => flyer.onUse(name)}>
            {flyer.uploading ? 'Uploading the photo…' : 'Use as the photo'}
          </Button>
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {flyer.error}
          </p>
        </div>
      )}
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
  cells,
  mark,
  sampleRows,
  onChange,
}: {
  name: string;
  def: Extract<FieldDef, { type: 'list' }>;
  rows: Record<string, unknown>[];
  problems: string[] | undefined;
  /** The cells a problem is about, as `rowNumber.column`: each is marked and points at the list's message. */
  cells: Set<string>;
  mark: FieldMark | undefined;
  /** By row, the cells still holding sample copy (`SampleFields`); a row is sample while any are. */
  sampleRows: string[][] | undefined;
  onChange: Edit;
}) {
  const setRows = (next: Record<string, unknown>[]) => onChange((d) => ({ ...d, data: { ...d.data, [name]: next } }));
  const full = def.maxItems !== undefined && rows.length >= def.maxItems;
  const blank = Object.fromEntries(Object.entries(def.item).map(([k, d]) => [k, startValue(d)]));
  const sampleId = `field-${name}-sample`;
  const isSampleRow = (i: number) => (sampleRows?.[i]?.length ?? 0) > 0;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1.5 font-medium">
        {def.label}
        {def.maxItems !== undefined && (
          <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
            {rows.length}/{def.maxItems}
          </span>
        )}
        {mark && (
          <span className="ml-2">
            <MarkPill mark={mark} />
          </span>
        )}
      </legend>
      {mark && <MarkNote id={`field-${name}-mark`} mark={mark} />}
      {rows.some((_, i) => isSampleRow(i)) && <SampleNote id={sampleId} rows />}
      {rows.map((row, i) => (
        // Rows have no ids of their own; their place is who they are.
        // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position in the list.
        <div key={i} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Row {i + 1}
              {isSampleRow(i) && ' · sample'}
            </span>
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
            const sampleCell = sampleRows?.[i]?.includes(k) === true;
            // Every cell of a sample row points at the list's note, the problem's message first.
            const describedBy = [cells.has(`${i + 1}.${k}`) && `field-${name}-error`, isSampleRow(i) && sampleId].filter(Boolean).join(' ') || undefined;
            return (
              <div key={k} className={d.type === 'boolean' ? 'flex items-center gap-2' : fieldClass}>
                <label htmlFor={id} className="text-sm">
                  {d.label}
                </label>
                <ScalarInput
                  id={id}
                  def={d}
                  value={row[k] ?? d.default}
                  invalid={cells.has(`${i + 1}.${k}`)}
                  describedBy={describedBy}
                  sample={sampleCell}
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

/** Draws the `shown` fields, each checked against all of the template's `fields`, as a publish checks it (#304). */
export function FieldForm({
  spotId,
  fields,
  shown,
  draft,
  assets,
  marks = {},
  sampleFields = null,
  flyer,
  onChange,
  onEdited,
}: {
  /** The spot the form edits: which of its fields were touched, and whether Publish was pressed. */
  spotId: string;
  fields: Record<string, FieldDef>;
  shown: Record<string, FieldDef>;
  draft: SpotDraft;
  assets: AssetView[];
  /** The agent's marks, by field, on a spot it just filled. */
  marks?: Record<string, FieldMark>;
  /** The saved spot's fields still holding its template's sample text, as the server records them (#360). */
  sampleFields?: SampleFields | null;
  flyer?: Flyer;
  onChange: Edit;
  /** Told which field changed, to take its mark away. */
  onEdited?: (name: string) => void;
}) {
  const checks = useAppStore((s) => s.spotEditor.checks[spotId]);
  const touch = useAppStore((s) => s.touchField);
  // In words; an empty field's problem only once touched or Publish was pressed.
  const raw = new Map(
    [...fieldProblems(fields, draft, Object.keys(shown))].flatMap(([name, list]) => {
      const seen = checks?.all || checks?.touched.includes(name);
      const kept = list.filter((p) => seen || !isEmptyProblem(p));
      return kept.length ? [[name, kept] as const] : [];
    }),
  );
  const problems = new Map([...raw].map(([name, list]) => [name, list.map((p) => problemWords(p, fields))] as const));
  return (
    <div className="flex flex-col gap-5">
      {Object.entries(shown).map(([name, def]) => {
        const p = problems.get(name);
        const mark = marks[name];
        const edit: Edit = (change) => {
          onChange(change);
          onEdited?.(name);
          touch(spotId, name);
        };
        if (def.type === 'image')
          return (
            <ImageField
              key={name}
              name={name}
              def={def}
              assetId={draft.assets[name]}
              assets={assets}
              problems={p}
              mark={mark}
              flyer={flyer}
              onChange={edit}
              onTouch={() => touch(spotId, name)}
            />
          );
        const value = draft.data[name] ?? def.default;
        if (def.type === 'list') {
          const rows = Array.isArray(value) ? value.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null) : [];
          const cells = new Set((raw.get(name) ?? []).flatMap((r) => problemCell(r) ?? []));
          return (
            <ListField
              key={name}
              name={name}
              def={def}
              rows={rows}
              problems={p}
              cells={cells}
              mark={mark}
              sampleRows={sampleFields?.lists[name]}
              onChange={edit}
            />
          );
        }
        const id = `field-${name}`;
        const errorId = `${id}-error`;
        const markId = `${id}-mark`;
        const sampleId = `${id}-sample`;
        const sample = sampleFields?.texts.includes(name) === true;
        const describedBy = [p && errorId, mark && markId, sample && sampleId].filter(Boolean).join(' ') || undefined;
        const set = (v: unknown) => edit((d) => ({ ...d, data: { ...d.data, [name]: v } }));
        return (
          <div key={name} className={def.type === 'boolean' ? 'flex flex-wrap items-center gap-x-3 gap-y-1.5' : fieldClass}>
            <span className="flex justify-between gap-2">
              <label htmlFor={id} className="font-medium">
                {def.label}
              </label>
              <span className="flex items-center gap-2">
                {mark && <MarkPill mark={mark} />}
                {def.type === 'text' && def.maxLength !== undefined && (
                  <span className={p ? 'font-mono text-xs font-semibold text-destructive' : 'font-mono text-xs text-muted-foreground'}>
                    {typeof value === 'string' ? value.length : 0}/{def.maxLength}
                  </span>
                )}
              </span>
            </span>
            <ScalarInput
              id={id}
              def={def}
              value={value}
              invalid={p !== undefined}
              describedBy={describedBy}
              sample={sample}
              onChange={set}
              onBlur={() => touch(spotId, name)}
            />
            {mark && <MarkNote id={markId} mark={mark} />}
            {sample && <SampleNote id={sampleId} />}
            <Problems id={errorId} problems={p} />
          </div>
        );
      })}
    </div>
  );
}
