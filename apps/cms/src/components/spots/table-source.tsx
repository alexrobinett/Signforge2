/**
 * The Source section for a template whose list fields can come from a table (issue #84; menu-board's
 * items): a CSV or JSON link, read at once to show its columns and first rows, then added as a
 * source; once bound, which column fills each item property, which rows (a filter) and in what
 * order, with the items a screen would show. Until then, and while the link is down, the items
 * are typed. State and actions: src/state/spot-source.ts.
 */
import { readPath, type FieldDef, type TableFeed, type TableMapping } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { KeepSource, LiveCard, SourceChoice } from '~/components/spots/source-parts';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import { useNow } from '~/lib/live';
import { type BindingInput, type DataSourceView, freshness, isFresh, isTableFormat, tableRows } from '~/lib/live-data';
import type { SpotDraft } from '~/lib/spots';
import { dataSourceQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';
import { sourceStateOf, type SourceTarget } from '~/state/spot-source';

type Edit = (change: (d: SpotDraft) => SpotDraft) => void;
type ListDef = Extract<FieldDef, { type: 'list' }>;

/** Rows the preview of a link shows. */
const FIRST_ROWS = 5;
/** The browser's locale: the stage plays in it too; a screen writes numbers in its own. */
const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first rows of a table, as read. */
function TablePreview({ table }: { table: TableFeed }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm text-muted-foreground">
        {plural(table.rows.length, 'row')}, {plural(table.columns.length, 'column')}.{table.rows.length > FIRST_ROWS && ` The first ${FIRST_ROWS}:`}
      </p>
      <div className="max-w-full overflow-x-auto rounded-lg border">
        <table aria-label="First rows of the file" className="w-full text-left text-sm">
          <thead className="bg-muted/60">
            <tr>
              {table.columns.map((c) => (
                <th key={c} scope="col" className="px-2.5 py-1.5 font-medium whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, FIRST_ROWS).map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a read-only preview, in the file's order.
              <tr key={i} className="border-t">
                {row.map((cell, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells by column, which can repeat a value.
                  <td key={j} className="max-w-48 truncate px-2.5 py-1.5 tabular-nums">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Which column fills each item property, which rows and in what order. Edits the draft's binding. */
function Mapping({ field, def, binding, columns, onChange }: { field: string; def: ListDef; binding: BindingInput; columns: string[]; onChange: Edit }) {
  const table = binding.table ?? { columns: {} };
  const set = (next: TableMapping) => onChange((d) => ({ ...d, bindings: { ...d.bindings, [field]: { ...binding, table: next } } }));
  // A column the file no longer has stays in the list, marked, until another is picked.
  const options = (current: string | undefined) => (current && !columns.includes(current) ? [...columns, current] : columns);
  const columnWord = (c: string) => (columns.includes(c) ? c : `${c} (not in the file)`);
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">Columns for each item</legend>
      <div className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        {Object.entries(def.item).map(([prop, d]) => {
          const current = table.columns[prop];
          const id = `map-${field}-${prop}`;
          return (
            <div key={prop} className="contents">
              <label htmlFor={id} className="text-sm">
                {d.label}
              </label>
              <NativeSelect
                id={id}
                value={current ?? ''}
                aria-invalid={(current !== undefined && !columns.includes(current)) || (current === undefined && d.default === undefined) || undefined}
                onChange={(e) => {
                  const { [prop]: _, ...rest } = table.columns;
                  set({ ...table, columns: e.target.value ? { ...rest, [prop]: e.target.value } : rest });
                }}
              >
                <option value="" disabled={d.default === undefined}>
                  {d.default === undefined ? 'Choose a column' : 'Not used'}
                </option>
                {options(current).map((c) => (
                  <option key={c} value={c}>
                    {columnWord(c)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          );
        })}
        <label htmlFor={`filter-${field}`} className="text-sm">
          Only rows where
        </label>
        <NativeSelect
          id={`filter-${field}`}
          value={table.filter?.column ?? ''}
          onChange={(e) => {
            const { filter: _, ...rest } = table;
            set(e.target.value ? { ...rest, filter: { column: e.target.value, equals: table.filter?.equals ?? '' } } : rest);
          }}
        >
          <option value="">Every row</option>
          {options(table.filter?.column).map((c) => (
            <option key={c} value={c}>
              {columnWord(c)}
            </option>
          ))}
        </NativeSelect>
        {table.filter && (
          <>
            <label htmlFor={`filter-${field}-equals`} className="text-sm">
              is
            </label>
            <Input
              id={`filter-${field}-equals`}
              value={table.filter.equals}
              maxLength={200}
              onChange={(e) => set({ ...table, filter: { column: table.filter?.column ?? '', equals: e.target.value } })}
            />
          </>
        )}
        <label htmlFor={`sort-${field}`} className="text-sm">
          Order
        </label>
        <NativeSelect
          id={`sort-${field}`}
          value={table.sort?.column ?? ''}
          onChange={(e) => {
            const { sort: _, ...rest } = table;
            set(e.target.value ? { ...rest, sort: { column: e.target.value, ...(table.sort?.descending ? { descending: true } : {}) } } : rest);
          }}
        >
          <option value="">As in the file</option>
          {options(table.sort?.column).map((c) => (
            <option key={c} value={c}>
              By {columnWord(c)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {table.sort && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={table.sort.descending === true}
            onChange={(e) => set({ ...table, sort: { column: table.sort?.column ?? '', ...(e.target.checked ? { descending: true } : {}) } })}
          />
          Highest or last first
        </label>
      )}
    </fieldset>
  );
}

/** A bound table: the items a screen shows from it, how fresh they are, and the mapping. */
function TableValues({
  target,
  draft,
  boundId,
  canManage,
  onChange,
}: {
  target: SourceTarget;
  draft: SpotDraft;
  boundId: string;
  canManage: boolean;
  onChange: Edit;
}) {
  const { orgId, spot, manifest, live } = target;
  const { data: read, dataUpdatedAt } = useSuspenseQuery(dataSourceQuery(orgId, boundId));
  const justRead = useAppStore((s) => s.readTables[boundId]);
  const changeSource = useAppStore((s) => s.changeSource);
  const now = useNow(dataUpdatedAt);
  if (!read)
    return (
      <p className="text-sm font-medium text-destructive">
        This spot's table is gone. Choose another, or type the items: until then screens show the typed items.
        {canManage && (
          <Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => changeSource(spot.id, true)}>
            Choose a table
          </Button>
        )}
      </p>
    );
  const { dataSource, snapshot } = read;
  // Before the first poll, what the editor read when it added the link.
  const data = snapshot?.data ?? justRead;
  const known = readPath(data, 'columns');
  const columns: string[] = Array.isArray(known) ? known.filter((c) => typeof c === 'string') : [];
  const rows = readPath(data, 'rows');
  // Read when it was added, not yet polled: what screens get after the first check.
  const firstRead = !snapshot && justRead !== undefined;
  const fresh = firstRead || isFresh(snapshot, now);
  const unbind = () => onChange((d) => ({ ...d, bindings: Object.fromEntries(Object.entries(d.bindings).filter(([f]) => !(f in live.fields))) }));
  return (
    <LiveCard fresh={fresh} instead="typed items" className="gap-3">
      <span className="font-medium break-words">{dataSource.name}</span>
      {Object.keys(live.fields).map((field) => {
        const def = manifest.fields[field];
        const binding = draft.bindings[field];
        if (def?.type !== 'list' || !binding) return null;
        const { items, problems } = data === undefined ? { items: undefined, problems: [] } : tableRows(manifest, field, binding, data, LOCALE);
        const first = (items ?? []).slice(0, 3).flatMap((item: unknown) => {
          const name = readPath(item, Object.keys(def.item)[0] ?? '');
          return typeof name === 'string' && name ? [name] : [];
        });
        return (
          <div key={field} className="flex flex-col gap-3">
            {items && (
              <div className="flex flex-col gap-1">
                <p className="text-sm">
                  {Array.isArray(rows) ? `${plural(rows.length, 'row')} in the file; ` : ''}
                  screens show {plural(items.length, 'item')}
                  {def.maxItems ? `, at most ${def.maxItems}` : ''}.
                </p>
                {first.length > 0 && (
                  <ul aria-label="First items" className="flex flex-col gap-0.5 border-l-2 border-primary/25 pl-2 text-sm">
                    {first.map((n, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the items in the order a screen shows them.
                      <li key={i} className="truncate">
                        {n}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {problems.length > 0 && (
              <p className="text-sm text-status-updating-foreground">
                {items ? `${plural(problems.length, 'row')} left out: ` : 'No items: '}
                {problems.slice(0, 2).join('; ').replace(`field "${field}": `, '')}
                {problems.length > 2 ? '…' : ''}
              </p>
            )}
            {canManage && <Mapping field={field} def={def} binding={binding} columns={columns} onChange={onChange} />}
          </div>
        );
      })}
      <p className="text-[13px] leading-snug text-foreground">
        {firstRead && !dataSource.lastError
          ? 'Read just now. Screens get it after the first check, within a minute.'
          : freshness(dataSource, snapshot, now).replaceAll('fallback values', 'typed items')}
      </p>
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="border-primary/30 text-primary" onClick={() => changeSource(spot.id, true)}>
            Change source
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={unbind}>
            Type the items instead
          </Button>
        </div>
      )}
    </LiveCard>
  );
}

/** Picks one of the org's tables, or reads a CSV or JSON link and adds it. */
function TablePicker({ target, sources, boundId }: { target: SourceTarget; sources: DataSourceView[]; boundId: string | undefined }) {
  const { spot } = target;
  const st = useAppStore((s) => sourceStateOf(s.spotSource, spot.id));
  const openForm = useAppStore((s) => s.openFeedForm);
  const editTable = useAppStore((s) => s.editTable);
  const readTable = useAppStore((s) => s.readTable);
  const addTable = useAppStore((s) => s.addTable);
  const tables = sources.filter((d) => isTableFormat(d.format));
  return (
    <div className="flex flex-col gap-3">
      {tables.length > 0 && <SourceChoice target={target} sources={tables} boundId={boundId} id="source-table" label="Table" word="table" />}
      {st.adding ? (
        <fieldset className="rounded-[10px] border p-3">
          {/* Floated, so it sits inside the frame instead of cutting its border. */}
          <legend className="float-left mb-3 font-medium">From a CSV or JSON link</legend>
          <div className="clear-left flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="table-url" className="text-sm font-medium">
                Address
              </label>
              <Input
                id="table-url"
                type="url"
                inputMode="url"
                value={st.tableUrl}
                onChange={(e) => editTable(spot.id, { tableUrl: e.target.value })}
                aria-describedby="table-url-help"
              />
              <p id="table-url-help" className="text-sm text-muted-foreground">
                An https link to a CSV file with a header row, or to JSON: a published spreadsheet, a file on your site. It is stored encrypted and never shown
                again.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="table-format" className="text-sm font-medium">
                  The file is
                </label>
                <NativeSelect
                  id="table-format"
                  value={st.tableFormat}
                  onChange={(e) => editTable(spot.id, { tableFormat: e.target.value === 'json-table' ? 'json-table' : 'csv' })}
                >
                  <option value="csv">CSV</option>
                  <option value="json-table">JSON</option>
                </NativeSelect>
              </div>
              {st.tableFormat === 'json-table' && (
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <label htmlFor="table-rows" className="text-sm font-medium">
                    Where the list is
                  </label>
                  <Input
                    id="table-rows"
                    value={st.rowsPath}
                    placeholder="data.items"
                    maxLength={200}
                    onChange={(e) => editTable(spot.id, { rowsPath: e.target.value })}
                    aria-describedby="table-rows-help"
                  />
                  <p id="table-rows-help" className="text-sm text-muted-foreground">
                    Empty when the file is the list.
                  </p>
                </div>
              )}
            </div>
            <Button type="button" variant="outline" className="self-start" disabled={st.reading || !st.tableUrl.trim()} onClick={() => void readTable(spot.id)}>
              {st.reading ? 'Reading…' : 'Read the file'}
            </Button>
            {/* Kept in the accessibility tree while empty, so the read's result is announced. */}
            <div role="status" className="empty:sr-only">
              {st.table && <TablePreview table={st.table} />}
            </div>
            {st.table && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="table-name" className="text-sm font-medium">
                    Name
                  </label>
                  <Input id="table-name" value={st.tableName} maxLength={100} onChange={(e) => editTable(spot.id, { tableName: e.target.value })} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={st.pending || !st.table.columns.length} onClick={() => void addTable(target)}>
                    {st.pending ? 'Adding…' : 'Use this file'}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => openForm(spot.id, false)}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        </fieldset>
      ) : (
        <Button type="button" variant="outline" className="self-start" onClick={() => openForm(spot.id, true)}>
          From a CSV or JSON link
        </Button>
      )}
      {boundId && <KeepSource spotId={spot.id} />}
    </div>
  );
}

export function TableSource({
  target,
  draft,
  sources,
  boundId,
  canManage,
  onChange,
}: {
  target: SourceTarget;
  draft: SpotDraft;
  sources: DataSourceView[];
  boundId: string | undefined;
  canManage: boolean;
  onChange: Edit;
}) {
  const changing = useAppStore((s) => sourceStateOf(s.spotSource, target.spot.id).changing);
  return (
    <>
      {boundId && <TableValues target={target} draft={draft} boundId={boundId} canManage={canManage} onChange={onChange} />}
      {canManage && (!boundId || changing) && <TablePicker target={target} sources={sources} boundId={boundId} />}
    </>
  );
}
