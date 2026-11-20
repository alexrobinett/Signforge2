/**
 * `SourceSection` (issue #79; canvas board Spot editor A, the "Live data" block): for a template
 * whose manifest declares live fields, where their data comes from. People choose the source (a
 * place and units, a news feed, a calendar), never the values: the bound fields show their live
 * values read-only, from the source's latest snapshot, and the static values a screen falls back
 * to sit in a collapsed "If the source is down" section. State and actions: src/state/spot-source.ts.
 */
import type { LiveData, TemplateManifest } from '@signforge/contract';
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

const INTRO: Record<LiveData['source'], string> = {
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
  orgId,
  spotId,
  dataSourceId,
  manifest,
  live,
  units,
  canManage,
  onChange,
}: {
  orgId: string;
  spotId: string;
  dataSourceId: string;
  manifest: TemplateManifest;
  live: LiveData;
  /** The units the spot shows a forecast in. */
  units: WeatherUnits;
  canManage: boolean;
  onChange: () => void;
}) {
  const { data: read, dataUpdatedAt } = useSuspenseQuery(dataSourceQuery(orgId, dataSourceId));
  const now = useNow(dataUpdatedAt);
  const focusRequested = useAppStore((s) => sourceStateOf(s.spotSource, spotId).focusChange);
  const focusedChange = useAppStore((s) => s.focusedChange);
  // After a bind the control that had focus is gone; this takes it, once.
  const takeFocus = useCallback(
    (el: HTMLButtonElement | null) => {
      if (!el || !focusRequested) return;
      el.focus();
      focusedChange(spotId);
    },
    [focusRequested, focusedChange, spotId],
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
      {fresh && summary && <p className="text-[15px] font-semibold">{summary}</p>}
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
      <p className="text-[13px] leading-snug text-foreground">{freshness(dataSource, snapshot, now)}</p>
      {canManage && (
        <Button ref={takeFocus} type="button" variant="outline" size="sm" className="self-start border-primary/30 text-primary" onClick={onChange}>
          Change source
        </Button>
      )}
    </LiveCard>
  );
}

function PlacePicker({ target, draft, bound }: { target: SourceTarget; draft: SpotDraft; bound: boolean }) {
  const { spot, manifest, live } = target;
  const st = useAppStore((s) => sourceStateOf(s.spotSource, spot.id));
  const typePlace = useAppStore((s) => s.typePlace);
  const pickUnits = useAppStore((s) => s.pickUnits);
  const connect = useAppStore((s) => s.connectWeather);
  const changeSource = useAppStore((s) => s.changeSource);
  const units: WeatherUnits = st.units ?? unitsOf(manifest, draft.data);
  const unitSelect = (kind: 'temperature' | 'wind', label: string) => {
    const field = live.units?.[kind];
    const def = field ? manifest.fields[field] : undefined;
    if (def?.type !== 'select') return null;
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`source-${kind}`} className="font-medium">
          {label}
        </label>
        <NativeSelect id={`source-${kind}`} value={units[kind]} onChange={(e) => pickUnits(spot.id, withUnit(units, kind, e.target.value))}>
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
        <label htmlFor="source-place" className="font-medium">
          Place
        </label>
        <Input
          id="source-place"
          type="search"
          autoComplete="off"
          value={st.placeQuery}
          onChange={(e) => typePlace(spot.id, e.target.value)}
          aria-describedby="source-place-help"
        />
        <p id="source-place-help" className="text-sm text-muted-foreground">
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
        <Button type="button" variant="ghost" className="self-start" onClick={() => changeSource(spot.id, false)}>
          Keep the current source
        </Button>
      )}
    </div>
  );
}

function FeedPicker({
  target,
  sources,
  boundId,
  format,
}: {
  target: SourceTarget;
  sources: DataSourceView[];
  boundId: string | undefined;
  format: 'rss' | 'ical';
}) {
  const { spot } = target;
  const st = useAppStore((s) => sourceStateOf(s.spotSource, spot.id));
  const openForm = useAppStore((s) => s.openFeedForm);
  const editFeed = useAppStore((s) => s.editFeed);
  const addFeed = useAppStore((s) => s.addFeed);
  const mine = sources.filter((d) => d.format === format);
  const word = format === 'ical' ? 'calendar' : 'feed';
  return (
    <div className="flex flex-col gap-3">
      {mine.length > 0 && (
        <SourceChoice target={target} sources={mine} boundId={boundId} id="source-feed" label={format === 'ical' ? 'Calendar' : 'News feed'} word={word} />
      )}
      {st.adding || mine.length === 0 ? (
        <fieldset className="rounded-[10px] border p-3">
          {/* Floated, so it sits inside the frame instead of cutting its border. */}
          <legend className="float-left mb-3 font-medium">Add a {word}</legend>
          <div className="clear-left flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="source-url" className="text-sm font-medium">
                Address
              </label>
              <Input
                id="source-url"
                type="url"
                inputMode="url"
                value={st.feedUrl}
                onChange={(e) => editFeed(spot.id, { feedUrl: e.target.value })}
                aria-describedby="source-url-help"
              />
              <p id="source-url-help" className="text-sm text-muted-foreground">
                {format === 'ical'
                  ? 'An https iCal address (.ics), such as a Google or Outlook calendar shared by link. It is stored encrypted and never shown again.'
                  : 'An https RSS or Atom address. It is stored encrypted and never shown again.'}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="source-name" className="text-sm font-medium">
                Name
              </label>
              <Input id="source-name" value={st.feedName} maxLength={100} onChange={(e) => editFeed(spot.id, { feedName: e.target.value })} />
            </div>
            {format === 'ical' && (
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="source-horizon" className="text-sm font-medium">
                  Days ahead
                </label>
                <Input
                  id="source-horizon"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={366}
                  value={st.horizonDays}
                  onChange={(e) => editFeed(spot.id, { horizonDays: Math.round(e.target.valueAsNumber) || 1 })}
                  className="w-24 text-center font-mono"
                />
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={st.pending || !st.feedUrl.trim()} onClick={() => void addFeed(target, format)}>
                {st.pending ? 'Adding…' : `Add ${word}`}
              </Button>
              {mine.length > 0 && (
                <Button type="button" variant="ghost" onClick={() => openForm(spot.id, false)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </fieldset>
      ) : (
        <Button type="button" variant="outline" className="self-start" onClick={() => openForm(spot.id, true)}>
          Add a {word} by its address
        </Button>
      )}
      {boundId && <KeepSource spotId={spot.id} />}
    </div>
  );
}

export function SourceSection({
  orgId,
  spot,
  manifest,
  live,
  draft,
  assets,
  canManage,
  onChange,
}: {
  orgId: string;
  spot: SpotView;
  manifest: TemplateManifest;
  live: LiveData;
  draft: SpotDraft;
  assets: AssetView[];
  canManage: boolean;
  onChange: Edit;
}) {
  const { dataSources } = useSuspenseQuery(dataSourcesQuery(orgId)).data;
  const changing = useAppStore((s) => sourceStateOf(s.spotSource, spot.id).changing);
  const error = useAppStore((s) => sourceStateOf(s.spotSource, spot.id).error);
  const changeSource = useAppStore((s) => s.changeSource);
  const fallbackOpen = useAppStore((s) => sourceStateOf(s.spotSource, spot.id).fallbackOpen);
  const toggleFallback = useAppStore((s) => s.toggleFallback);
  const boundId = boundSource(live, draft.bindings);
  const target: SourceTarget = { orgId, spot, manifest, live };
  const fallback = liveFields(manifest, live);
  const fallbackBad = [...fieldProblems(fallback, draft).keys()].length > 0;
  const fallbackShown = fallbackOpen || fallbackBad;
  const place = live.place ? draft.data[live.place] : undefined;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{INTRO[live.source]}</p>
      {boundId && live.source !== 'table' && (
        <LiveValues
          orgId={orgId}
          spotId={spot.id}
          dataSourceId={boundId}
          manifest={manifest}
          live={live}
          units={unitsOf(manifest, draft.data)}
          canManage={canManage}
          onChange={() => changeSource(spot.id, true, typeof place === 'string' ? place : '')}
        />
      )}
      {canManage && (!boundId || changing) && live.source === 'open-meteo' && <PlacePicker target={target} draft={draft} bound={boundId !== undefined} />}
      {canManage && (!boundId || changing) && (live.source === 'rss' || live.source === 'ical') && (
        <FeedPicker target={target} sources={dataSources} boundId={boundId} format={live.source} />
      )}
      {live.source === 'table' && (
        <TableSource target={target} draft={draft} sources={dataSources} boundId={boundId} canManage={canManage} onChange={onChange} />
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      {/* A disclosure the store controls: open while the person has it open, and while a fallback value is invalid. An unbound table's items are typed in Content. */}
      <div hidden={live.source === 'table' && !boundId} className="rounded-[10px] border">
        <button
          type="button"
          aria-expanded={fallbackShown}
          aria-controls="source-fallback"
          onClick={() => toggleFallback(spot.id, fallbackBad || !fallbackShown)}
          className="flex w-full cursor-pointer items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronRightIcon className={cn('size-4 text-muted-foreground transition-transform', fallbackShown && 'rotate-90')} aria-hidden />
          If the source is down
        </button>
        <div id="source-fallback" hidden={!fallbackShown} className="flex flex-col gap-4 px-3 pb-4">
          <p className="text-sm text-muted-foreground">What screens show while the source has no fresh data. They start as the template's own values.</p>
          <FieldForm fields={fallback} draft={draft} assets={assets} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}
