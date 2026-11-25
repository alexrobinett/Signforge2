/**
 * `SourceSection` (issue #79; canvas board Spot editor A, the "Live data" block): for a template
 * whose manifest declares live fields, where their data comes from. People choose the source (a
 * place and units, a news feed, a calendar), never the values: the bound fields show their live
 * values read-only, from the source's latest snapshot, and the static values a screen falls back
 * to sit in a collapsed "If the source is down" section. A template with several named sources
 * (#193) has one such block for each, under its label. State and actions: src/state/spot-source.ts.
 */
import type { LiveData, LiveSourceDef, TemplateManifest } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ChevronRightIcon } from 'lucide-react';
import { useCallback } from 'react';
import { FieldForm } from '~/components/spots/field-form';
import { KeepSource, LiveCard, SourceChoice } from '~/components/spots/source-parts';
import { TableSource } from '~/components/spots/table-source';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import type { AssetView } from '~/lib/assets';
import { useNow } from '~/lib/live';
import {
  boundSource,
  freshness,
  isFresh,
  liveFields,
  liveValue,
  placeName,
  rowTitles,
  unitsOf,
  weatherWords,
  withUnit,
  type DataSourceView,
  type PlaceView,
  type WeatherUnits,
} from '~/lib/live-data';
import { fieldProblems, type SpotDraft, type SpotView } from '~/lib/spots';
import { cn } from '~/lib/utils';
import { dataSourceQuery, dataSourcesQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';
import { sourceStateOf, type SourceTarget } from '~/state/spot-source';

type Edit = (change: (d: SpotDraft) => SpotDraft) => void;

const INTRO: Record<LiveSourceDef['source'], string> = {
  'open-meteo': 'Pick a place: the temperature, conditions, wind and humidity come from its forecast and update by themselves.',
  rss: 'Pick a news feed: the headlines come from it and update by themselves.',
  ical: 'Pick a calendar: the events come from it and update by themselves.',
  table: 'Type the items below, or fill them from a CSV or JSON file on the web: each row is an item, and screens follow the file.',
};

/** Open-Meteo's values with their units; the condition and day or night are in the summary instead. */
const WEATHER_SUFFIX: [RegExp, (u: WeatherUnits) => string][] = [
  [/temperature/, (u) => u.temperature],
  [/wind_speed/, (u) => ` ${u.wind}`],
  [/humidity/, () => '%'],
];
const IN_SUMMARY = new Set(['current.weather_code', 'current.is_day']);

/** A live value as the read-only list shows it. */
function shown(value: unknown, suffix = ''): string {
  if (value === undefined || value === null) return 'No value';
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  if (typeof value === 'string') return value || 'None';
  if (typeof value === 'number') return `${value}${suffix}`;
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** A field's label without its help in brackets: "Feed language (BCP 47, e.g. fr-FR)" is "Feed language". */
const shortLabel = (label: string) => label.replace(/\s*\(.*\)$/, '');

/** What a place search found, as its status message says it. */
function searchWords(places: PlaceView[] | null): string {
  if (!places) return '';
  if (!places.length) return 'No place by that name.';
  return `${places.length} ${places.length === 1 ? 'place' : 'places'} found.`;
}

function LiveValues({
  target,
  dataSourceId,
  units,
  canManage,
  onChange,
}: {
  target: SourceTarget;
  dataSourceId: string;
  /** The units the spot shows a forecast in. */
  units: WeatherUnits;
  canManage: boolean;
  onChange: () => void;
}) {
  const { orgId, manifest, live } = target;
  const { data: read, dataUpdatedAt } = useSuspenseQuery(dataSourceQuery(orgId, dataSourceId));
  const now = useNow(dataUpdatedAt);
  const focusRequested = useAppStore((s) => sourceStateOf(s.spotSource, target).focusChange);
  const focusedChange = useAppStore((s) => s.focusedChange);
  // After a bind the control that had focus is gone; this takes it, once. It depends on the
  // picker's names, not on `target`, which its section makes anew on every render.
  const spotId = target.spot.id;
  const source = target.source;
  const takeFocus = useCallback(
    (el: HTMLButtonElement | null) => {
      if (!el || !focusRequested) return;
      el.focus();
      focusedChange({ spot: { id: spotId }, source });
    },
    [focusRequested, focusedChange, spotId, source],
  );
  if (!read)
    return (
      <p className="text-sm font-medium text-destructive">
        This spot's source is gone. Choose another: until then screens show the fallback values.
        {canManage && (
          <Button type="button" variant="outline" size="sm" className="ml-2" onClick={onChange}>
            Choose a source
          </Button>
        )}
      </p>
    );
  const { dataSource, snapshot } = read;
  const fresh = isFresh(snapshot, now);
  const weather = live.source === 'open-meteo';
  const temperature = weather ? liveValue(snapshot, 'current.temperature_2m') : undefined;
  const summary =
    typeof temperature === 'number'
      ? [
          `${Math.round(temperature)}${units.temperature}`,
          weatherWords(liveValue(snapshot, 'current.weather_code')),
          liveValue(snapshot, 'current.is_day') === 0 ? 'night' : undefined,
        ]
          .filter(Boolean)
          .join(', ')
      : undefined;
  const rows = Object.entries(live.fields).filter(([, path]) => !(weather && IN_SUMMARY.has(path)));
  return (
    <LiveCard fresh={fresh} instead="fallback" className="gap-2.5">
      <span className="font-medium break-words">{dataSource.name}</span>
      {fresh && summary && <p className="text-md font-semibold">{summary}</p>}
      {fresh && (
        <dl aria-label="Live values" className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
          {rows.map(([field, path]) => {
            const value = liveValue(snapshot, path);
            const first = rowTitles(value);
            const suffix = weather ? WEATHER_SUFFIX.find(([p]) => p.test(path))?.[1](units) : undefined;
            return (
              <div key={field} className="contents">
                <dt className="text-muted-foreground">{shortLabel(manifest.fields[field]?.label ?? field)}</dt>
                <dd className="text-right tabular-nums">{shown(value, suffix)}</dd>
                {first.length > 0 && (
                  <dd className="col-span-2 mb-1">
                    <ul className="flex flex-col gap-0.5 border-l-2 border-primary/25 pl-2">
                      {first.map((r, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the rows are a read-only snapshot, in its order.
                        <li key={i} className="truncate">
                          {r}
                        </li>
                      ))}
                    </ul>
                  </dd>
                )}
              </div>
            );
          })}
        </dl>
      )}
      <p className="text-meta leading-snug text-foreground">{freshness(dataSource, snapshot, now)}</p>
      {canManage && (
        <Button ref={takeFocus} type="button" variant="outline" size="sm" className="self-start border-primary/30 text-primary" onClick={onChange}>
          Change source
        </Button>
      )}
    </LiveCard>
  );
}

function PlacePicker({ target, ids, draft, bound }: { target: SourceTarget; ids: string; draft: SpotDraft; bound: boolean }) {
  const { manifest, live } = target;
  const st = useAppStore((s) => sourceStateOf(s.spotSource, target));
  const typePlace = useAppStore((s) => s.typePlace);
  const pickUnits = useAppStore((s) => s.pickUnits);
  const connect = useAppStore((s) => s.connectWeather);
  const changeSource = useAppStore((s) => s.changeSource);
  const units: WeatherUnits = st.units ?? unitsOf(manifest, live, draft.data);
  const unitSelect = (kind: 'temperature' | 'wind', label: string) => {
    const field = live.units?.[kind];
    const def = field ? manifest.fields[field] : undefined;
    if (def?.type !== 'select') return null;
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}.${kind}`} className="font-medium">
          {label}
        </label>
        <NativeSelect id={`${ids}.${kind}`} value={units[kind]} onChange={(e) => pickUnits(target, withUnit(units, kind, e.target.value))}>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </NativeSelect>
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}.place`} className="font-medium">
          Place
        </label>
        <Input
          id={`${ids}.place`}
          type="search"
          autoComplete="off"
          value={st.placeQuery}
          onChange={(e) => typePlace(target, e.target.value)}
          aria-describedby={`${ids}.place-help`}
        />
        <p id={`${ids}.place-help`} className="text-sm text-muted-foreground">
          Type a city or town and pick it. The forecast comes from Open-Meteo.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        {unitSelect('temperature', 'Temperature in')}
        {unitSelect('wind', 'Wind in')}
      </div>
      {/* Kept in the accessibility tree while empty (hidden from sight only), so its first message is announced. */}
      <p role="status" className="text-sm text-muted-foreground empty:sr-only">
        {st.searching ? 'Looking…' : searchWords(st.places)}
      </p>
      {!st.searching && st.places && st.places.length > 0 && (
        <ul aria-label="Places found" className="flex flex-col gap-1.5">
          {st.places.map((p) => (
            <li key={p.id}>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-10 w-full justify-start py-2 text-left whitespace-normal"
                disabled={st.pending}
                onClick={() => void connect(target, p, units)}
              >
                {placeName(p)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {bound && (
        <Button type="button" variant="ghost" className="self-start" onClick={() => changeSource(target, false)}>
          Keep the current source
        </Button>
      )}
    </div>
  );
}

function FeedPicker({
  target,
  ids,
  sources,
  boundId,
  format,
}: {
  target: SourceTarget;
  ids: string;
  sources: DataSourceView[];
  boundId: string | undefined;
  format: 'rss' | 'ical';
}) {
  const st = useAppStore((s) => sourceStateOf(s.spotSource, target));
  const openForm = useAppStore((s) => s.openFeedForm);
  const editFeed = useAppStore((s) => s.editFeed);
  const addFeed = useAppStore((s) => s.addFeed);
  const mine = sources.filter((d) => d.format === format);
  const word = format === 'ical' ? 'calendar' : 'feed';
  return (
    <div className="flex flex-col gap-3">
      {mine.length > 0 && (
        <SourceChoice target={target} sources={mine} boundId={boundId} id={`${ids}.feed`} label={format === 'ical' ? 'Calendar' : 'News feed'} word={word} />
      )}
      {st.adding || mine.length === 0 ? (
        <fieldset className="rounded-lg border p-3">
          {/* Floated, so it sits inside the frame instead of cutting its border. */}
          <legend className="float-left mb-3 font-medium">Add a {word}</legend>
          <div className="clear-left flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}.url`} className="text-sm font-medium">
                Address
              </label>
              <Input
                id={`${ids}.url`}
                type="url"
                inputMode="url"
                value={st.feedUrl}
                onChange={(e) => editFeed(target, { feedUrl: e.target.value })}
                aria-describedby={`${ids}.url-help`}
              />
              <p id={`${ids}.url-help`} className="text-sm text-muted-foreground">
                {format === 'ical'
                  ? 'An https iCal address (.ics), such as a Google or Outlook calendar shared by link. It is stored encrypted and never shown again.'
                  : 'An https RSS or Atom address. It is stored encrypted and never shown again.'}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}.name`} className="text-sm font-medium">
                Name
              </label>
              <Input id={`${ids}.name`} value={st.feedName} maxLength={100} onChange={(e) => editFeed(target, { feedName: e.target.value })} />
            </div>
            {format === 'ical' && (
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={`${ids}.horizon`} className="text-sm font-medium">
                  Days ahead
                </label>
                <Input
                  id={`${ids}.horizon`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={366}
                  value={st.horizonDays}
                  onChange={(e) => editFeed(target, { horizonDays: Math.round(e.target.valueAsNumber) || 1 })}
                  className="w-24 text-center tabular-nums"
                />
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={st.pending || !st.feedUrl.trim()} onClick={() => void addFeed(target, format)}>
                {st.pending ? 'Adding…' : `Add ${word}`}
              </Button>
              {mine.length > 0 && (
                <Button type="button" variant="ghost" onClick={() => openForm(target, false)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </fieldset>
      ) : (
        <Button type="button" variant="outline" className="self-start" onClick={() => openForm(target, true)}>
          Add a {word} by its address
        </Button>
      )}
      {boundId && <KeepSource at={target} />}
    </div>
  );
}

type SectionProps = {
  orgId: string;
  spot: SpotView;
  manifest: TemplateManifest;
  live: LiveData;
  draft: SpotDraft;
  assets: AssetView[];
  canManage: boolean;
  onChange: Edit;
};

/** One of the template's sources: where its fields come from, their live values, and their fallback. `ids` starts its controls' element ids, joined to each by a dot, which a source name cannot hold, so no two sources' ids meet. */
function LiveSource({
  target,
  ids,
  draft,
  assets,
  canManage,
  onChange,
}: Omit<SectionProps, 'orgId' | 'spot' | 'manifest' | 'live'> & { target: SourceTarget; ids: string }) {
  const { orgId, manifest, live } = target;
  const { dataSources } = useSuspenseQuery(dataSourcesQuery(orgId)).data;
  const changing = useAppStore((s) => sourceStateOf(s.spotSource, target).changing);
  const error = useAppStore((s) => sourceStateOf(s.spotSource, target).error);
  const changeSource = useAppStore((s) => s.changeSource);
  const fallbackOpen = useAppStore((s) => sourceStateOf(s.spotSource, target).fallbackOpen);
  const toggleFallback = useAppStore((s) => s.toggleFallback);
  const boundId = boundSource(live, draft.bindings);
  const fallback = liveFields(manifest, live);
  const fallbackBad = fieldProblems(manifest.fields, draft, Object.keys(fallback)).size > 0;
  const fallbackShown = fallbackOpen || fallbackBad;
  const place = live.place ? draft.data[live.place] : undefined;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{INTRO[live.source]}</p>
      {boundId && live.source !== 'table' && (
        <LiveValues
          target={target}
          dataSourceId={boundId}
          units={unitsOf(manifest, live, draft.data)}
          canManage={canManage}
          onChange={() => changeSource(target, true, typeof place === 'string' ? place : '')}
        />
      )}
      {canManage && (!boundId || changing) && live.source === 'open-meteo' && (
        <PlacePicker target={target} ids={ids} draft={draft} bound={boundId !== undefined} />
      )}
      {canManage && (!boundId || changing) && (live.source === 'rss' || live.source === 'ical') && (
        <FeedPicker target={target} ids={ids} sources={dataSources} boundId={boundId} format={live.source} />
      )}
      {live.source === 'table' && (
        <TableSource target={target} ids={ids} draft={draft} sources={dataSources} boundId={boundId} canManage={canManage} onChange={onChange} />
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      {/* A disclosure the store controls: open while the person has it open, and while a fallback value is invalid. An unbound table's items are typed in Content. */}
      <div hidden={live.source === 'table' && !boundId} className="rounded-lg border">
        <button
          type="button"
          aria-expanded={fallbackShown}
          aria-controls={`${ids}.fallback`}
          onClick={() => toggleFallback(target, fallbackBad || !fallbackShown)}
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronRightIcon className={cn('size-4 text-muted-foreground transition-transform', fallbackShown && 'rotate-90')} aria-hidden />
          If the source is down
        </button>
        <div id={`${ids}.fallback`} hidden={!fallbackShown} className="flex flex-col gap-4 px-3 pb-4">
          <p className="text-sm text-muted-foreground">What screens show while the source has no fresh data. They start as the template's own values.</p>
          <FieldForm spotId={target.spot.id} fields={manifest.fields} shown={fallback} draft={draft} assets={assets} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

export function SourceSection({ orgId, spot, manifest, live, ...rest }: SectionProps) {
  const target = (source: string, def: LiveSourceDef): SourceTarget => ({ orgId, spot, manifest, source, live: def });
  if (!('sources' in live)) return <LiveSource target={target('source', live)} ids="source" {...rest} />;
  return (
    <div className="flex flex-col gap-6">
      {Object.entries(live.sources).map(([name, def]) => (
        <fieldset key={name} className="flex min-w-0 flex-col gap-3">
          <legend className="mb-2 font-semibold">{def.label}</legend>
          <LiveSource target={target(name, def)} ids={`source-${name}`} {...rest} />
        </fieldset>
      ))}
    </div>
  );
}
