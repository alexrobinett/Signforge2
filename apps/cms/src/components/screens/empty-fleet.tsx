/**
 * The Screens page of an org with no screens (canvas board "Empty fleet", research idea 10): one
 * path, pairing, with the code input on the page. "Open a test screen" (a player in a browser tab,
 * M3-41) is its first step once that ticket gives it a URL: pass `testScreenHref`.
 */
import { ExternalLinkIcon } from 'lucide-react';
import type { GroupView } from '~/lib/screen-types';
import { PairScreenForm } from './pair-screen-form';

export function EmptyFleet({ groups, canManage, testScreenHref }: { groups: GroupView[]; canManage: boolean; testScreenHref?: string }) {
  return (
    <section aria-labelledby="empty-fleet" className="flex flex-wrap items-center gap-9 rounded-xl border bg-card p-5 sm:p-9">
      <div className="flex max-w-xl min-w-0 flex-[1_1_26rem] flex-col gap-6">
        <div className="space-y-2">
          <h2 id="empty-fleet" className="text-2xl font-semibold tracking-tight">
            See your first spot on a screen
          </h2>
          <p className="text-[15px] leading-relaxed text-foreground/85">
            Turn on a screen with the SignForge player. It shows a pairing code; type it here and the screen is yours. A test screen in a browser tab runs the
            same player and pairs the same way.
          </p>
        </div>
        {canManage ? (
          <ol className="flex flex-col gap-6">
            {testScreenHref && (
              <li className="flex gap-3.5">
                <Step n={1} />
                <a
                  href={testScreenHref}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex h-11 items-center gap-2 self-start rounded-lg bg-primary px-4 text-[15px] font-semibold text-primary-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  Open a test screen <ExternalLinkIcon className="size-4" aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            )}
            <li className="flex gap-3.5">
              {testScreenHref && <Step n={2} />}
              <div className="min-w-0 flex-1">
                <PairScreenForm groups={groups} compact />
              </div>
            </li>
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Ask an editor or owner of this organization to pair a screen.</p>
        )}
        <p className="border-t pt-4 text-sm leading-relaxed text-foreground/85">
          Pairing a real screen? You need a Raspberry Pi 4 with the SignForge image. It shows its code when it starts.
        </p>
      </div>

      <figure className="m-0 flex min-w-0 flex-[1_1_24rem] flex-col gap-2.5">
        <div className="overflow-hidden rounded-xl border border-border-strong bg-card shadow-[0_12px_32px_rgba(16,24,40,0.12)]">
          <div aria-hidden className="flex h-10 items-center gap-2.5 border-b bg-muted px-3 text-xs text-muted-foreground">
            <span className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-border-strong" />
              <span className="size-2.5 rounded-full bg-border-strong" />
              <span className="size-2.5 rounded-full bg-border-strong" />
            </span>
            <span className="rounded-md bg-card px-2.5 py-1">SignForge player</span>
            <span className="flex-1 truncate rounded-md bg-card px-2.5 py-1 font-mono">…/player/pair</span>
          </div>
          <div
            role="img"
            aria-label="A screen showing its pairing code"
            className="flex aspect-video flex-col items-center justify-center gap-3 bg-[#0f1115] text-white"
          >
            <span className="text-[15px] text-[#d0d5dd]">Pair this screen</span>
            <span className="font-mono text-4xl font-semibold tracking-[0.08em] sm:text-5xl">K7M 2QX</span>
            <span className="text-[13px] text-[#b8b8b8]">Enter this code in SignForge to add the screen</span>
          </div>
        </div>
        <figcaption className="text-[13px] text-muted-foreground">
          What a screen shows until it is paired. After pairing it plays what you publish to it, and appears here with its status.
        </figcaption>
      </figure>
    </section>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span aria-hidden className="grid size-7 flex-none place-items-center rounded-full bg-primary text-[13px] font-semibold text-primary-foreground">
      {n}
    </span>
  );
}
