/**
 * Whether a player can play a manifest (#156): the one rule the server and the player both use. A manifest needs its
 * schema and the frame protocol of each of its templates; a player can play what it reports in its sync
 * (`SyncRequest.player`), and this build what `THIS_PLAYER` names.
 */
import { SUPPORTED_MANIFEST_SCHEMAS, SUPPORTED_PROTOCOLS, type ScreenManifest } from './shapes.ts';

/** What a manifest needs of a player: its schema, and the frame protocols its templates were built against. */
export interface ManifestNeeds {
  schema: number;
  /** Each template's frame protocol, once each; 1 for a bundle that names none. */
  protocols: number[];
}

/** What a player can play: the manifest schemas and frame protocols it reports. */
export interface PlayerPlays {
  readonly manifestSchemas: readonly number[];
  readonly protocols: readonly number[];
}

/** What this build of the player can play. */
export const THIS_PLAYER: PlayerPlays = { manifestSchemas: SUPPORTED_MANIFEST_SCHEMAS, protocols: SUPPORTED_PROTOCOLS };

/** What `m` needs of a player to play it. */
export const manifestNeeds = (m: Pick<ScreenManifest, 'schema' | 'templates'>): ManifestNeeds => ({
  schema: m.schema,
  protocols: [...new Set(Object.values(m.templates ?? {}).map((t) => t.manifest?.protocol ?? 1))],
});

/** Whether `player` plays manifests of `schema`. */
export const playsSchema = (player: PlayerPlays, schema: unknown): boolean => typeof schema === 'number' && player.manifestSchemas.includes(schema);

/** Whether `player` drives templates built against frame `protocol`. */
export const playsProtocol = (player: PlayerPlays, protocol: number): boolean => player.protocols.includes(protocol);

/**
 * Whether `player` can play a manifest that needs `needs`: its schema, and every template's protocol. A manifest with
 * no whole-number schema, stored before schemas were numbered, is judged by its protocols alone, as the server always has.
 */
export const canPlay = (player: PlayerPlays, needs: ManifestNeeds): boolean =>
  (!Number.isInteger(needs.schema) || playsSchema(player, needs.schema)) && needs.protocols.every((p) => playsProtocol(player, p));
