/**
 * The code a screen shows, typed as six boxes in two groups of three. Pasting the whole code into
 * any box fills them all. Case, spaces and dashes do not matter; the server reads it the same way.
 */
import { useRef } from 'react';
import { cn } from '~/lib/utils';

export const PAIRING_CODE_LENGTH = 6;

export const normaliseCode = (raw: string) =>
  raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, PAIRING_CODE_LENGTH);

export function PairingCodeInput({
  value,
  onChange,
  labelledBy,
  describedBy,
  invalid,
}: {
  value: string;
  onChange: (code: string) => void;
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const chars = value.padEnd(PAIRING_CODE_LENGTH).split('');
  const focus = (i: number) => boxes.current[Math.max(0, Math.min(PAIRING_CODE_LENGTH - 1, i))]?.focus();

  function put(i: number, typed: string) {
    const clean = normaliseCode(typed);
    if (clean.length > 1) {
      // A paste: the whole code, from this box on.
      const next = normaliseCode(value.slice(0, i) + clean);
      onChange(next);
      focus(next.length);
      return;
    }
    const padded = value.padEnd(i);
    onChange(normaliseCode(padded.slice(0, i) + clean + padded.slice(i + 1)));
    if (clean) focus(i + 1);
  }

  return (
    <fieldset aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex items-center gap-2">
      {chars.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the boxes are fixed positions in the code.
        <span key={i} className="contents">
          {i === PAIRING_CODE_LENGTH / 2 && <span aria-hidden className="h-0.5 w-3 rounded bg-border-strong" />}
          <input
            ref={(el) => {
              boxes.current[i] = el;
            }}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-label={`Character ${i + 1} of ${PAIRING_CODE_LENGTH}`}
            aria-invalid={invalid || undefined}
            value={c.trim()}
            onChange={(e) => {
              // One character typed (over the one there, if any), or a whole code filled in at once.
              const typed = normaliseCode(e.target.value);
              put(i, typed.length > 2 ? typed : typed.slice(-1));
            }}
            onPaste={(e) => {
              e.preventDefault();
              put(i, e.clipboardData.getData('text'));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !c.trim() && i > 0) {
                e.preventDefault();
                onChange(value.slice(0, i - 1));
                focus(i - 1);
              } else if (e.key === 'ArrowLeft') focus(i - 1);
              else if (e.key === 'ArrowRight') focus(i + 1);
            }}
            className={cn(
              'h-14 w-11 rounded-lg border border-input bg-card text-center font-mono text-2xl font-semibold uppercase shadow-xs outline-none sm:w-12',
              'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive',
            )}
          />
        </span>
      ))}
    </fieldset>
  );
}
