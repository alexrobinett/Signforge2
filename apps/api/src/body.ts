/**
 * A request's body as bytes, or undefined once it is over `max`: a declared length is refused unread, and no body is
 * read past the ceiling. With a declared length the bytes are read into one buffer of that size, so a body near the
 * ceiling is held once, not once per copy.
 */
export async function boundedBytes(req: Request, max: number): Promise<Uint8Array | undefined> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN);
  if (declared > max) return undefined;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  let buffer = new Uint8Array(Number.isSafeInteger(declared) ? declared : 0);
  let size = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    if (size + r.value.byteLength > max) {
      await reader.cancel();
      return undefined;
    }
    if (size + r.value.byteLength > buffer.byteLength) {
      // No length declared, or more than declared: grow by doubling, up to the ceiling.
      const grown = new Uint8Array(Math.min(max, Math.max(size + r.value.byteLength, buffer.byteLength * 2)));
      grown.set(buffer.subarray(0, size));
      buffer = grown;
    }
    buffer.set(r.value, size);
    size += r.value.byteLength;
  }
  return buffer.subarray(0, size);
}
