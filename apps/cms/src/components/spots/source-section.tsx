/**
 * `SourceSection` (issue #79; canvas board Spot editor A, the "Live data" block): for a template
 * whose manifest declares live fields, where their data comes from. People choose the source (a
 * place and units, a news feed, a calendar), never the values: the bound fields show their live
 * values read-only, from the source's latest snapshot, and the static values a screen falls back
 * to sit in a collapsed "If the source is down" section. State and actions: src/state/spot-source.ts.
 */
import { type LiveData, SNAPSHOT_STALE_MS, type TemplateManifest } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link2Icon } from 'lucide-react';
import { FieldForm } from '~/components/spots/field-form';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import type { AssetView } from '~/lib/assets';
import { useNow } from '~/lib/live';
import {
  boundSource,
  liveFields,
  liveValue,
  placeName,
  pollErrorWords,
  SOURCE_FORMAT,
  unitsOf,
  weatherWords,
  withUnit,
  type DataSourceView,
  type SnapshotView,
  type WeatherUnits,
} from '~/lib/live-data';
import { ago } from '~/lib/screen-status';
import { fieldProblems, type SpotDraft, type SpotView } from '~/lib/spots';
import { dataSourceQuery, dataSourcesQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';
import { sourceStateOf, type SourceTarget } from '~/state/spot-source';

type Edit = (change: (d: SpotDraft) => SpotDraft) => void;

const INTRO: Record<LiveData['source'], string> = {
  'open-meteo': 'Pick a place: the temperature, conditions, wind and humidity come from its forecast and update by themselves.',
  rss: 'Pick a news feed: the headlines come from it and update by themselves.',
  ical: 'Pick a calendar: the events come from it and update by themselves.',
};

/** A live value as the read-only list shows it; Open-Meteo's codes in words. */
function shown(path: string, value: unknown): string {
  if (path === 'current.weather_code' && typeof value === 'number') return `${value} (${weatherWords(value) ?? 'unknown'})`;
  if (path === 'current.is_day' && typeof value === 'number') return value === 1 ? 'Day' : 'Night';
  if (value === undefined || value === null) return 'No value yet';
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  if (typeof value === 'string') return value || 'None';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** The first rows of a live list, by their first text: headlines, events. */
function firstRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((row: unknown) => {
    const text = typeof row === 'object' && row !== null ? Object.values(row).find((v) => typeof v === 'string' && v) : undefined;
    return typeof text === 'string' ? [text] : [];
  });
}

/** How fresh the source's data is, and what screens do about it. */
function freshness(source: DataSourceView, snapshot: SnapshotView | null, now: number): string {
  const failing = source.lastError ? pollErrorWords(source.lastError) : undefined;
  if (!snapshot)
    return failing
      ? `The first check failed: ${failing}. Screens show the fallback values until it works.`
      : 'Waiting for the first check, within a minute. Until then screens show the fallback values.';
  const checked = Date.parse(snapshot.checkedAt);
  if (now - checked > SNAPSHOT_STALE_MS) return `Not confirmed for ${ago(now - checked)}: screens show the fallback values.`;
  const when = `Checked ${ago(now - checked)} ago.`;
  return failing ? `${when} The last check failed: ${failing}. Screens keep this data for a day, then show the fallback values.` : when;
}

function LiveValues({
  orgId,
  dataSourceId,
  manifest,
  live,
  unit,
  canManage,
  onChange,
}: {
  orgId: string;
  dataSourceId: string;
  manifest: TemplateManifest;
  live: LiveData;
  /** The temperature unit the spot shows. */
  unit: string;
  canManage: boolean;
  onChange: () => void;
}) {
  const { data: read, dataUpdatedAt } = useSuspenseQuery(dataSourceQuery(orgId, dataSourceId));
  const now = useNow(dataUpdatedAt);
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
  const temperature = live.source === 'open-meteo' ? liveValue(snapshot, 'current.temperature_2m') : undefined;
  const summary =
    typeof temperature === 'number'
      ? [`${Math.round(temperature)}${unit}`, weatherWords(liveValue(snapshot, 'current.weather_code'))].filter(Boolean).join(', ')
      : undefined;
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-primary/25 bg-accent p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 font-medium break-words">{dataSource.name}</span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-accent-foreground">
          <Link2Icon className="size-3.5" aria-hidden />
          Live data
        </span>
      </div>
      {summary && <p className="text-[15px] font-semibold">{summary}</p>}
      {snapshot && (
        <dl aria-label="Live values" className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
          {Object.entries(live.fields).map(([field, path]) => {
            const value = liveValue(snapshot, path);
            const rows = firstRows(value);
            return (
              <div key={field} className="contents">
                <dt className="text-muted-foreground">{manifest.fields[field]?.label ?? field}</dt>
                <dd className="text-right font-mono">{shown(path, value)}</dd>
                {rows.length > 0 && (
                  <dd className="col-span-2 mb-1">
                    <ul className="flex flex-col gap-0.5 border-l-2 border-primary/25 pl-2">
                      {rows.map((r, i) => (
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
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onChange}>
          Change source
        </Button>
      )}
    </div>
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
      {st.searching && <p className="text-sm text-muted-foreground">Looking…</p>}
      {!st.searching && st.places?.length === 0 && <p className="text-sm text-muted-foreground">No place by that name.</p>}
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

function FeedPicker({ target, sources, boundId }: { target: SourceTarget; sources: DataSourceView[]; boundId: string | undefined }) {
  const { spot, live } = target;
  const st = useAppStore((s) => sourceStateOf(s.spotSource, spot.id));
  const connect = useAppStore((s) => s.connectSource);
  const openForm = useAppStore((s) => s.openFeedForm);
  const editFeed = useAppStore((s) => s.editFeed);
  const addFeed = useAppStore((s) => s.addFeed);
  const changeSource = useAppStore((s) => s.changeSource);
  const format = SOURCE_FORMAT[live.source];
  const mine = sources.filter((d) => d.format === format);
  const word = format === 'ical' ? 'calendar' : 'feed';
  return (
    <div className="flex flex-col gap-3">
      {mine.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="source-feed" className="font-medium">
            {format === 'ical' ? 'Calendar' : 'News feed'}
          </label>
          <NativeSelect id="source-feed" value={boundId ?? ''} disabled={st.pending} onChange={(e) => e.target.value && void connect(target, e.target.value)}>
            <option value="" disabled>
              Choose a {word}
            </option>
            {mine.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {st.adding || mine.length === 0 ? (
        <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
          <legend className="px-1 font-medium">Add a {word}</legend>
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
            <Button type="button" disabled={st.pending || !st.feedUrl.trim()} onClick={() => void addFeed(target)}>
              {st.pending ? 'Adding…' : `Add ${word}`}
            </Button>
            {mine.length > 0 && (
              <Button type="button" variant="ghost" onClick={() => openForm(spot.id, false)}>
                Cancel
              </Button>
            )}
          </div>
        </fieldset>
      ) : (
        <Button type="button" variant="outline" className="self-start" onClick={() => openForm(spot.id, true)}>
          Add a {word} by its address
        </Button>
      )}
      {boundId && (
        <Button type="button" variant="ghost" className="self-start" onClick={() => changeSource(spot.id, false)}>
          Keep the current source
        </Button>
      )}
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
  const boundId = boundSource(live, draft.bindings);
  const target: SourceTarget = { orgId, spot, manifest, live };
  const fallback = liveFields(manifest, live);
  const fallbackBad = [...fieldProblems(fallback, draft).keys()].length > 0;
  const place = live.place ? draft.data[live.place] : undefined;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{INTRO[live.source]}</p>
      {boundId && (
        <LiveValues
          orgId={orgId}
          dataSourceId={boundId}
          manifest={manifest}
          live={live}
          unit={unitsOf(manifest, draft.data).temperature}
          canManage={canManage}
          onChange={() => changeSource(spot.id, true, typeof place === 'string' ? place : '')}
        />
      )}
      {canManage &&
        (!boundId || changing) &&
        (live.source === 'open-meteo' ? (
          <PlacePicker target={target} draft={draft} bound={boundId !== undefined} />
        ) : (
          <FeedPicker target={target} sources={dataSources} boundId={boundId} />
        ))}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <details className="rounded-lg border" open={fallbackBad || undefined}>
        <summary className="cursor-pointer rounded-lg px-3 py-2.5 font-medium">If the source is down</summary>
        <div className="flex flex-col gap-4 px-3 pb-4">
          <p className="text-sm text-muted-foreground">What screens show while the source has no fresh data. They start as the template's own values.</p>
          <FieldForm fields={fallback} draft={draft} assets={assets} onChange={onChange} />
        </div>
      </details>
    </div>
  );
}
