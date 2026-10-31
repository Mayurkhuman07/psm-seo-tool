import { AppError } from "@/server/lib/errors";
import {
  isIpLiteral,
  isNonPublicHost,
  isPrivateIpv4,
  isPrivateIpv6,
  normalizeHost,
} from "@/server/lib/audit/private-hosts";
import { publicFetch } from "@/server/lib/public-fetch";
import type { CrawlerAccess } from "@/shared/crawler-access";
import { auditRequestHeaders } from "@/server/lib/audit/web-bot-auth";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

type DnsJsonAnswer = {
  type?: number;
  data?: string;
};

type DnsJsonResponse = {
  Status?: number;
  Answer?: DnsJsonAnswer[];
};

async function resolveAddressRecords(
  hostname: string,
  type: "A" | "AAAA",
): Promise<string[]> {
  const response = await fetch(
    `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
    {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(2_500),
    },
  );

  if (!response.ok) return [];

  const body: DnsJsonResponse = await response.json();
  if (body.Status !== 0 || !Array.isArray(body.Answer)) return [];

  const expectedType = type === "A" ? 1 : 28;
  return body.Answer.filter(
    (answer): answer is Required<Pick<DnsJsonAnswer, "data" | "type">> =>
      answer.type === expectedType && typeof answer.data === "string",
  ).map((answer) => normalizeHost(answer.data));
}

async function hostnameResolvesToBlockedAddress(
  hostname: string,
): Promise<boolean> {
  const host = normalizeHost(hostname);
  if (!host || isIpLiteral(host)) return false;

  try {
    const [v4, v6] = await Promise.all([
      resolveAddressRecords(host, "A"),
      resolveAddressRecords(host, "AAAA"),
    ]);

    const addresses = [...v4, ...v6];
    if (addresses.length === 0) return false;

    return addresses.some(
      (address) => isPrivateIpv4(address) || isPrivateIpv6(address),
    );
  } catch {
    return false;
  }
}

/**
 * Shopify storefronts, custom domains included, resolve into Shopify's
 * 23.227.38.0/24. This identifies a store even when its edge answers with a
 * bare 429 that carries no `powered-by` header.
 */
export async function isShopifyHost(hostname: string): Promise<boolean> {
  try {
    const addresses = await resolveAddressRecords(normalizeHost(hostname), "A");
    return addresses.some((address) => address.startsWith("23.227.38."));
  } catch {
    return false;
  }
}

/**
 * Synchronous SSRF check for URLs discovered mid-crawl (links, redirect
 * targets, sitemap entries). Blocks non-http(s) schemes, private/loopback IP
 * literals, and internal hostnames. DNS resolution is only performed for the
 * start URL (see normalizeAndValidateStartUrl); per-link DoH lookups would be
 * prohibitively slow.
 */
export function isCrawlableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return !isNonPublicHost(parsed.hostname);
}

export async function normalizeAndValidateStartUrl(
  input: string,
): Promise<string> {
  let raw = input.trim();
  if (!raw) throw new AppError("VALIDATION_ERROR");

  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("VALIDATION_ERROR");
  }

  if (isNonPublicHost(parsed.hostname)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }

  if (await hostnameResolvesToBlockedAddress(parsed.hostname)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }

  parsed.hash = "";
  return parsed.toString();
}

const START_URL_REDIRECT_HOPS = 5;
const START_URL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Follow redirects on the audit's start URL so the audit anchors to the
 * site's real origin. Without this, auditing a domain that 301s elsewhere
 * (…net -> …com, apex -> www) dead-ends after one page: the redirect target
 * is a different origin, so the same-origin crawl policy can't follow it.
 *
 * Every hop re-runs the full start-URL validation (SSRF, blocked hosts), so
 * a redirect can't smuggle the audit somewhere the user couldn't have
 * pointed it directly. Probe failures (timeouts, HEAD rejected) fall back
 * to the last validated URL — the crawl records the real fetch result.
 *
 * Also reports the final response's `powered-by` header, which is how a
 * Shopify storefront identifies itself.
 */
export async function resolveStartUrlRedirects(
  startUrl: string,
  access?: CrawlerAccess | null,
): Promise<{ url: string; poweredBy: string | null }> {
  let current = startUrl;
  for (let hop = 0; hop < START_URL_REDIRECT_HOPS; hop++) {
    let response: Response;
    try {
      response = await publicFetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: await auditRequestHeaders(current, access),
        signal: AbortSignal.timeout(START_URL_PROBE_TIMEOUT_MS),
      });
    } catch {
      return { url: current, poweredBy: null };
    }
    if (response.status < 300 || response.status >= 400) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }
    const location = response.headers.get("location");
    if (!location) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { url: current, poweredBy: null };
    }
    current = await normalizeAndValidateStartUrl(next.toString());
  }
  return { url: current, poweredBy: null };
}
