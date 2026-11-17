/**
 * The publish fan-out: a Queue consumer that, per screen, writes a manifest (R2 when bound),
 * one D1 row and one Durable Object call. The consumer records its batch size and how many
 * subrequests it made, and whether any failed.
 */
export interface FanoutMessage { run: string; screen: string; manifestId: string }

export async function consumeFanout(batch: MessageBatch<FanoutMessage>, env: Env) {
  let subrequests = 0;
  let error: string | null = null;
  try {
    for (const msg of batch.messages) {
      const { run, screen, manifestId } = msg.body;
      const media = (env as { MEDIA?: R2Bucket }).MEDIA;
      if (media) {
        await media.put(`m/${screen}/${manifestId}.json`, JSON.stringify({ manifestId }));
        subrequests++;
      }
      await env.DB.prepare('INSERT INTO fanout_screens (run, screen, manifest_id) VALUES (?, ?, ?)').bind(run, screen, manifestId).run();
      subrequests++;
      await env.SCREEN.getByName(`fanout-${screen}`).nudge(manifestId);
      subrequests++;
      msg.ack();
    }
  } catch (e) {
    error = String((e as Error).message).slice(0, 200);
  }
  const run = batch.messages[0]?.body.run ?? 'none';
  await env.DB.prepare('INSERT INTO fanout_batches (run, batch_size, subrequests, error, at) VALUES (?, ?, ?, ?, ?)')
    .bind(run, batch.messages.length, subrequests, error, Date.now())
    .run();
}
