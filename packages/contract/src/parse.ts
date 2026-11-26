/**
 * Each validator in `validate.ts` as a parser: the same check, but a value that passes comes back
 * typed, so a caller never casts what it has just checked. The device messages are read by their declared shapes
 * (`shape.ts`, #156) and come back as exactly the shape, any key they do not declare left out; the rest still pass
 * the input itself through this file's cast until #156's next steps.
 */
import type { BrandKit, DataSnapshot, DisplayHours, PreviewHostMessage, ScreenManifest, TemplateManifest, TemplateRuntimeReport } from './shapes.ts';
import {
  deviceCommandShape,
  deviceSocketMessageShape,
  displayHoursProblems,
  pairPollResponseShape,
  pairStartRequestShape,
  pairStartResponseShape,
  serverSocketMessageShape,
  syncRequestShape,
  syncResponseShape,
  validateBrandKit,
  validateDataSnapshot,
  validateManifest,
  validatePreviewHostMessage,
  validateTemplateManifest,
  validateTemplateRuntimeReport,
} from './validate.ts';

/** The input itself, typed, when it passes; otherwise the validator's problems. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const parser =
  <T>(validate: (input: unknown) => string[]) =>
  (input: unknown): Parsed<T> => {
    const problems = validate(input);
    return problems.length ? { ok: false, problems } : { ok: true, value: input as T };
  };

export const parseTemplateManifest = parser<TemplateManifest>(validateTemplateManifest);
export const parseBrandKit = parser<BrandKit>(validateBrandKit);
export const parseDisplayHours = parser<DisplayHours>(displayHoursProblems);
export const parseManifest = parser<ScreenManifest>(validateManifest);
export const parseDataSnapshot = parser<DataSnapshot>(validateDataSnapshot);
export const parsePairStartRequest = pairStartRequestShape.read;
export const parsePairStartResponse = pairStartResponseShape.read;
export const parsePairPollResponse = pairPollResponseShape.read;
export const parseDeviceCommand = deviceCommandShape.read;
export const parseSyncRequest = syncRequestShape.read;
export const parseSyncResponse = syncResponseShape.read;
export const parseServerSocketMessage = serverSocketMessageShape.read;
export const parseDeviceSocketMessage = deviceSocketMessageShape.read;
export const parsePreviewHostMessage = parser<PreviewHostMessage>(validatePreviewHostMessage);
export const parseTemplateRuntimeReport = parser<TemplateRuntimeReport>(validateTemplateRuntimeReport);
