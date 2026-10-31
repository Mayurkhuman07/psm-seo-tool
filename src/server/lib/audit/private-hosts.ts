/**
 * Which hosts are not reachable on the public internet.
 *
 * Two callers, for two reasons. url-policy blocks these as an SSRF guard, so
 * the crawler never fetches them. page-reporters skips the HTTPS check for
 * them, because plain HTTP on localhost or an internal host is normal and
 * flagging it would bury a self-hosted audit under one false positive per page.
 *
 * A leaf module on purpose: page-reporters is a pure function over a crawled
 * page, and importing url-policy would drag fetch and request signing into it.
 */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
];

export function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host.includes("%")) {
    host = host.split("%", 1)[0];
  }
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  return host;
}

export function isPrivateIpv4(host: string): boolean {
  const parts = normalizeHost(host)
    .split(".")
    .map((x) => Number(x));
  if (
    parts.length !== 4 ||
    parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function parseMappedIpv4FromIpv6(host: string): string | null {
  const normalized = normalizeHost(host);
  if (!normalized.startsWith("::ffff:")) return null;

  const mapped = normalized.slice("::ffff:".length);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
    return mapped;
  }

  const segments = mapped.split(":").filter(Boolean);
  if (segments.length !== 2) return null;

  const high = Number.parseInt(segments[0], 16);
  const low = Number.parseInt(segments[1], 16);
  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }

  const a = (high >> 8) & 0xff;
  const b = high & 0xff;
  const c = (low >> 8) & 0xff;
  const d = low & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

export function isPrivateIpv6(host: string): boolean {
  const value = normalizeHost(host);
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  ) {
    return true;
  }

  const mappedIpv4 = parseMappedIpv4FromIpv6(value);
  if (mappedIpv4 && isPrivateIpv4(mappedIpv4)) {
    return true;
  }

  return false;
}

export function isIpLiteral(host: string): boolean {
  const normalized = normalizeHost(host);
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalized) || normalized.includes(":");
}

export function isNonPublicHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  if (isIpLiteral(host)) {
    return isPrivateIpv4(host) || isPrivateIpv6(host);
  }

  return false;
}
