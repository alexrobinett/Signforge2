/**
 * Each validator in `validate.ts` as a parser: the same check, but a value that passes comes back
 * typed, so a caller never casts what it has just checked. This file holds the contract's only
 * cast from a checked `unknown` to its shape.
 */
import type {
  BrandKit,
  DataSnapshot,
  DeviceCommand,
  DeviceSocketMessage,
  DisplayHours,
  PairPollResponse,
  PairStartRequest,
  PairStartResponse,
  PreviewHostMessage,
  ScreenManifest,
  ServerSocketMessage,
  SyncRequest,
  SyncResponse,
  TemplateManifest,
  TemplateRuntimeReport,
} from './shapes.ts';
import {
  displayHoursProblems,
  validateBrandKit,
  validateDataSnapshot,
  validateDeviceCommand,
  validateDeviceSocketMessage,
  validateManifest,
  validatePairPollResponse,
  validatePairStartRequest,
  validatePairStartResponse,
  validatePreviewHostMessage,
  validateServerSocketMessage,
  validateSyncRequest,
  validateSyncResponse,
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
export const parsePairStartRequest = parser<PairStartRequest>(validatePairStartRequest);
export const parsePairStartResponse = parser<PairStartResponse>(validatePairStartResponse);
export const parsePairPollResponse = parser<PairPollResponse>(validatePairPollResponse);
export const parseDeviceCommand = parser<DeviceCommand>(validateDeviceCommand);
export const parseSyncRequest = parser<SyncRequest>(validateSyncRequest);
export const parseSyncResponse = parser<SyncResponse>(validateSyncResponse);
export const parseServerSocketMessage = parser<ServerSocketMessage>(validateServerSocketMessage);
export const parseDeviceSocketMessage = parser<DeviceSocketMessage>(validateDeviceSocketMessage);
export const parsePreviewHostMessage = parser<PreviewHostMessage>(validatePreviewHostMessage);
export const parseTemplateRuntimeReport = parser<TemplateRuntimeReport>(validateTemplateRuntimeReport);
