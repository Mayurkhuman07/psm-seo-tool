import { describe, expect, it } from "vitest";
import { readTextUpTo } from "@/server/lib/audit/html-response";

/** A body comfortably larger than the caps used below, so the read truncates. */
function bigResponse(): Response {
  return new Response("x".repeat(4_000), {
    headers: { "content-type": "text/html" },
  });
}

describe("readTextUpTo", () => {
  it("reads a clone and then the original of the same body", async () => {
    // The 429 path in crawlPage: logRateLimited takes a short snippet from a
    // clone, then crawlPage reads the original in full. Cloning tees the body,
    // and a tee'd branch's cancel() only settles once both branches are
    // cancelled — so awaiting it here used to hang the crawl forever against
    // any site that answered 429 with a body over the snippet cap.
    const response = bigResponse();

    const snippet = await readTextUpTo(response.clone(), 80);
    expect(snippet).toHaveLength(80);

    const full = await readTextUpTo(response, 4_000);
    expect(full).toHaveLength(4_000);
  });
});
