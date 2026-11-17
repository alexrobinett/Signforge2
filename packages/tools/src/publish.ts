/** Publishing: make a stored manifest a screen's desired manifest. */
import { z } from 'zod';
import { id } from './fields';
import { manifestKey } from './r2';
import { defineTool, notFound, ToolError } from './tool';

const SHA256 = /^[0-9a-f]{64}$/;

export const publishManifestToScreen = defineTool({
  name: 'publish_manifest_to_screen',
  description:
    "Make a manifest already uploaded for a screen its desired manifest, so the screen switches to it on its next sync. The manifest it replaces stays available to the screen while it switches. Use it to publish what `sf push` uploaded or to roll back to the screen's previousManifestId. Publishing the current manifest again changes nothing. Returns { screenId, manifestId, changed }.",
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    screenId: id('screen'),
    manifestId: z.string().regex(SHA256, 'not a manifest id (64 lowercase hex characters)').describe("The manifest's id, the SHA-256 in its `id` field"),
  }),
  example: { screenId: 'scr_example', manifestId: '0'.repeat(64) },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, blobs, input }) => {
    const screen = await org.screens.get(input.screenId);
    if (!screen) throw notFound('screen', input.screenId);
    // A manifest is stored only once every file it lists is in R2 (the /admin upload checks), so
    // a stored manifest is one the screen can fetch completely. The key is under this org alone.
    if (!(await blobs.head(manifestKey(org.orgId, screen.id, input.manifestId)))) {
      throw new ToolError('not_found', `manifest ${input.manifestId} has not been uploaded for screen ${screen.id}`);
    }
    if (!(await org.screens.setDesiredManifest(screen.id, input.manifestId))) throw notFound('screen', input.screenId);
    return { screenId: screen.id, manifestId: input.manifestId, changed: screen.desiredManifestId !== input.manifestId };
  },
});

export const publishTools = [publishManifestToScreen];
