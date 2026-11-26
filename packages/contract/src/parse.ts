/**
 * Each shape in `validate.ts` as a parser: the same check as its validator, but a value that passes comes back typed,
 * as exactly the shape, any key it does not declare left out (`shape.ts`, #156). A caller never casts what it has just
 * checked.
 */
import {
  brandKitShape,
  dataSnapshotShape,
  deviceCommandShape,
  deviceSocketMessageShape,
  pairPollResponseShape,
  pairStartRequestShape,
  pairStartResponseShape,
  playerReleaseManifestShape,
  playerReleaseOfferShape,
  previewHostMessageShape,
  serverSocketMessageShape,
  supervisorAliveResponseShape,
  syncRequestShape,
  syncResponseShape,
  templateManifestShape,
  templateRuntimeReportShape,
  validDisplayHoursShape,
  validManifestShape,
} from './validate.ts';

/** The value, typed, when it passes; otherwise the validator's problems. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

export const parseTemplateManifest = templateManifestShape.read;
export const parseBrandKit = brandKitShape.read;
export const parseDisplayHours = validDisplayHoursShape.read;
export const parseManifest = validManifestShape.read;
export const parseDataSnapshot = dataSnapshotShape.read;
export const parsePairStartRequest = pairStartRequestShape.read;
export const parsePairStartResponse = pairStartResponseShape.read;
export const parsePairPollResponse = pairPollResponseShape.read;
export const parseDeviceCommand = deviceCommandShape.read;
export const parseSyncRequest = syncRequestShape.read;
export const parseSyncResponse = syncResponseShape.read;
export const parseServerSocketMessage = serverSocketMessageShape.read;
export const parseDeviceSocketMessage = deviceSocketMessageShape.read;
export const parsePreviewHostMessage = previewHostMessageShape.read;
export const parseTemplateRuntimeReport = templateRuntimeReportShape.read;
export const parsePlayerReleaseManifest = playerReleaseManifestShape.read;
export const parsePlayerReleaseOffer = playerReleaseOfferShape.read;
export const parseSupervisorAliveResponse = supervisorAliveResponseShape.read;
