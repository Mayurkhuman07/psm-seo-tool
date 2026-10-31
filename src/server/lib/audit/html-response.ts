import type { Response as BrowserResponse } from "@cloudflare/workers-types";

export const MAX_HTML_BYTES = 1024 * 1024;

export async function readTextUpTo(
  response: Response | BrowserResponse,
  maxBytes: number,
) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const result = await reader.read();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array))
        throw new Error("Expected response bytes");

      const remaining = maxBytes - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: true }));

      if (bytesRead >= maxBytes) {
        // Deliberately not awaited. On a branch of a tee'd body — which is
        // what response.clone() produces — cancel() only settles once *both*
        // branches are cancelled, so awaiting it here deadlocks whenever the
        // caller still means to read the other branch. logRateLimited reads a
        // clone of a 429 before crawlPage reads the original, so any site
        // answering 429 with a body over maxBytes hung the crawl forever.
        void reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  parts.push(decoder.decode());
  return parts.join("");
}

/** The first `maxBytes` of `text` as UTF-8, as readTextUpTo keeps from a body. */
export function truncateToBytes(text: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= maxBytes
    ? text
    : new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

/** Read a response body up to maxBytes; null when the body exceeds it. */
export async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
