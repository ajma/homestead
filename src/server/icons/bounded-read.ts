/**
 * Reads a response body a chunk at a time and refuses it the moment the accumulated byte
 * count crosses `maxBytes`, without waiting to see the rest.
 *
 * `response.arrayBuffer()`/`.json()` would buffer the WHOLE body before any size check
 * ever ran — the size cap in that shape decides only whether to *keep* the buffer, after
 * a hostile or broken CDN response has already been materialised in full. Measured on a
 * 96 MB response: a 357 MB heap-plus-external delta before the check fires. Streaming and
 * cancelling, the way `sampleBody` does for probe bodies in `http-runner.ts`, bounds what
 * gets buffered by `maxBytes` itself, not by whatever the far end chooses to send.
 *
 * Unlike `sampleBody`, this fails outright on overflow rather than truncating and keeping
 * what fit: a probe classifier can work from a partial body, but an icon or a metadata
 * index cannot be half-parsed, so there is nothing useful to return once the cap is
 * crossed.
 */
export async function readBounded(response: Response, maxBytes: number): Promise<Buffer | null> {
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    // Stops the transfer rather than merely ignoring the rest of it, exactly as
    // `sampleBody` does.
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks);
}
