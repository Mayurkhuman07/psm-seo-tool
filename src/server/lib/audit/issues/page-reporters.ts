/**
 * Per-page issue reporters.
 *
 * Each reporter is a pure function over a single crawled page record —
 * DOM-free by design (HTML parsing runs once in crawlPage), so the engine works
 * over any crawl source that can produce a CrawledPageResult.
 *
 * Cross-page checks (duplicates, broken links, orphans, redirect chains)
 * live in multipage.ts and run over D1 after the crawl.
 */
import type { AuditIssueType } from "@/shared/audit-issues";
import type { CrawledPageResult } from "@/server/lib/audit/types";

export interface DetectedIssue {
  issueType: AuditIssueType;
  pageId: string | null;
  pageUrl: string;
  details?: Record<string, unknown>;
  /**
   * Distinguishes multiple issues of the same type on the same page
   * (e.g. one broken-internal-link issue per target). Part of the
   * deterministic row id, so step retries don't duplicate issues.
   */
  dedupeKey?: string;
}

const TITLE_MAX_CHARS = 60;
const TITLE_MIN_CHARS = 10;
const META_DESCRIPTION_MAX_CHARS = 160;
const META_DESCRIPTION_MIN_CHARS = 70;
const THIN_CONTENT_WORDS = 150;
const SLOW_RESPONSE_MS = 1500;
const DEEP_PAGE_DEPTH = 5;
const LARGE_PAGE_BYTES = 1_000_000;
/** Visible text as a share of the HTML; below this the page is mostly markup. */
const MIN_TEXT_RATIO = 0.1;
/** Ratio needs a real document behind it — tiny pages swing wildly. */
const TEXT_RATIO_MIN_BYTES = 2_048;
const MAX_SEO_FRIENDLY_PATH_CHARS = 120;
/** Lowercase, digits, hyphen and the path separators a clean URL needs. */
const SEO_FRIENDLY_PATH = /^[a-z0-9\-/._~]*$/;
/** Links reported per page; one issue carries the sample, not one per link. */
const MIXED_CONTENT_SAMPLE = 5;
// Meta tags are uncapped in the HTML, so bound the copy stored on each issue.
const MAX_FLAGGED_TEXT_CHARS = 100;

function truncateFlaggedText(text: string): string {
  return text.length > MAX_FLAGGED_TEXT_CHARS
    ? `${text.slice(0, MAX_FLAGGED_TEXT_CHARS)}…`
    : text;
}

/**
 * Why a URL fails the SEO-friendliness test, or an empty list when it passes.
 * Mirrors the sub-checks a URL is conventionally judged on: readable
 * characters, no dynamic parameters, and a bounded path length.
 */
function urlFriendlinessFailures(rawUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }
  const failures: string[] = [];
  if (parsed.search) failures.push("dynamic parameters");
  if (!SEO_FRIENDLY_PATH.test(parsed.pathname)) {
    failures.push("uppercase, underscores or non-Latin characters");
  }
  if (parsed.pathname.length > MAX_SEO_FRIENDLY_PATH_CHARS) {
    failures.push(`path longer than ${MAX_SEO_FRIENDLY_PATH_CHARS} characters`);
  }
  return failures;
}

function hasHeadingLevelSkip(headingOrder: number[]): boolean {
  for (let i = 1; i < headingOrder.length; i++) {
    if (headingOrder[i] > headingOrder[i - 1] + 1) return true;
  }
  return false;
}

type PageFinding = {
  issueType: AuditIssueType;
  details?: Record<string, unknown>;
};

/**
 * Markup- and URL-level checks, kept apart from the content checks because
 * they stay valid for an unrendered app shell — nothing here claims anything
 * about the page's copy.
 */
function documentHygieneIssues(page: CrawledPageResult): PageFinding[] {
  const found: PageFinding[] = [];

  if (!page.hasDoctype) found.push({ issueType: "no-doctype" });
  if (!page.charsetDeclared) found.push({ issueType: "no-charset-declaration" });
  if (page.metaRefresh !== null) {
    found.push({
      issueType: "meta-refresh-redirect",
      details: { content: page.metaRefresh },
    });
  }
  if (page.titleTagCount > 1) {
    found.push({
      issueType: "duplicate-title-tag",
      details: { titleTagCount: page.titleTagCount },
    });
  }
  if (page.hasFrames) found.push({ issueType: "frame-usage" });
  if (page.deprecatedTags.length > 0) {
    found.push({
      issueType: "deprecated-html-tags",
      details: { tags: page.deprecatedTags },
    });
  }
  // A missing favicon is a site-wide fact. Reporting it per page would bury
  // the report under one identical row per URL, so only the entry point
  // carries it.
  if (page.crawlDepth === 0 && !page.hasFavicon) {
    found.push({ issueType: "no-favicon" });
  }
  if (page.htmlBytes > LARGE_PAGE_BYTES) {
    found.push({
      issueType: "large-page-size",
      details: { htmlBytes: page.htmlBytes },
    });
  }

  const urlFailures = urlFriendlinessFailures(page.url);
  if (urlFailures.length > 0) {
    found.push({
      issueType: "non-seo-friendly-url",
      details: { reasons: urlFailures },
    });
  }

  // A secure page that links onward over HTTP drops the user out of HTTPS.
  if (page.url.startsWith("https://")) {
    const insecureTargets = page.links
      .filter((link) => link.targetUrl.startsWith("http://"))
      .map((link) => link.targetUrl);
    if (insecureTargets.length > 0) {
      found.push({
        issueType: "mixed-content-links",
        details: {
          count: insecureTargets.length,
          sample: insecureTargets.slice(0, MIXED_CONTENT_SAMPLE),
        },
      });
    }
  }

  return found;
}

export function runPageReporters(page: CrawledPageResult): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const report = (
    issueType: AuditIssueType,
    details?: Record<string, unknown>,
  ) => issues.push({ issueType, pageId: page.id, pageUrl: page.url, details });

  if (page.fetchClass === "blocked") {
    report("blocked-page", { statusCode: page.statusCode });
    return issues;
  }
  if (page.fetchClass === "rate_limited") {
    report("rate-limited-page", { statusCode: page.statusCode });
    return issues;
  }
  if (page.fetchClass === "error") {
    return issues;
  }

  if (page.statusCode >= 500) {
    report("server-error", { statusCode: page.statusCode });
    return issues;
  }
  if (page.statusCode >= 400) {
    report("broken-page", { statusCode: page.statusCode });
    return issues;
  }
  // Redirects are normal on their own; chains/loops are flagged in multipage.
  if (page.statusCode >= 300) {
    return issues;
  }

  if (page.responseTimeMs > SLOW_RESPONSE_MS) {
    report("slow-response", { responseTimeMs: page.responseTimeMs });
  }

  // Transport security applies to every resource, not just HTML documents.
  if (page.url.startsWith("http://")) {
    report("insecure-page");
  }

  // Content checks only make sense for analyzed HTML documents (a PDF has no
  // title tag to miss).
  if (!page.isHtml) {
    return issues;
  }

  // Indexability + canonical signals
  if (!page.isIndexable) {
    report("noindex-page", {
      robotsMeta: page.robotsMeta,
      xRobotsTag: page.xRobotsTag,
    });
  }
  if (
    page.canonicalUrl &&
    page.headerCanonicalUrl &&
    page.canonicalUrl !== page.headerCanonicalUrl
  ) {
    report("canonical-conflict", {
      htmlCanonical: page.canonicalUrl,
      headerCanonical: page.headerCanonicalUrl,
    });
  }
  const effectiveCanonical = page.canonicalUrl ?? page.headerCanonicalUrl;
  if (effectiveCanonical && effectiveCanonical !== page.url) {
    report("canonicalized-page", { canonicalUrl: effectiveCanonical });
  }

  if (page.crawlDepth !== null && page.crawlDepth >= DEEP_PAGE_DEPTH) {
    report("deep-page", { crawlDepth: page.crawlDepth });
  }

  for (const finding of documentHygieneIssues(page)) {
    report(finding.issueType, finding.details);
  }

  // The initial app shell cannot establish what the rendered page is missing.
  // Report the coverage gap instead of thin-content/missing-heading claims.
  if (page.javascriptShell) {
    report("javascript-rendering-suspected", { wordCount: page.wordCount });
    return issues;
  }

  // Titles
  if (!page.title) {
    report("missing-title");
  } else if (page.title.length > TITLE_MAX_CHARS) {
    report("title-too-long", {
      length: page.title.length,
      max: TITLE_MAX_CHARS,
      title: truncateFlaggedText(page.title),
    });
  } else if (page.title.length < TITLE_MIN_CHARS) {
    report("title-too-short", {
      length: page.title.length,
      min: TITLE_MIN_CHARS,
      title: page.title,
    });
  }

  // Meta description
  if (!page.metaDescription) {
    report("missing-meta-description");
  } else if (page.metaDescription.length > META_DESCRIPTION_MAX_CHARS) {
    report("meta-description-too-long", {
      length: page.metaDescription.length,
      max: META_DESCRIPTION_MAX_CHARS,
      description: truncateFlaggedText(page.metaDescription),
    });
  } else if (page.metaDescription.length < META_DESCRIPTION_MIN_CHARS) {
    report("meta-description-too-short", {
      length: page.metaDescription.length,
      min: META_DESCRIPTION_MIN_CHARS,
      description: page.metaDescription,
    });
  }

  // Headings
  if (page.h1Count === 0) {
    report("missing-h1");
  } else if (page.h1Count > 1) {
    report("multiple-h1", { h1Count: page.h1Count });
  }
  if (hasHeadingLevelSkip(page.headingOrder)) {
    report("heading-order-skip");
  }

  // Content quality
  if (page.isIndexable && page.wordCount < THIN_CONTENT_WORDS) {
    report("thin-content", { wordCount: page.wordCount });
  }
  if (page.imagesMissingAlt > 0) {
    report("images-missing-alt", {
      imagesMissingAlt: page.imagesMissingAlt,
      imagesTotal: page.imagesTotal,
    });
  }
  if (page.hasLoremIpsum) {
    report("lorem-ipsum");
  }
  if (page.htmlBytes >= TEXT_RATIO_MIN_BYTES) {
    const textRatio = page.textLength / page.htmlBytes;
    if (textRatio < MIN_TEXT_RATIO) {
      report("low-text-ratio", {
        textRatio: Number(textRatio.toFixed(3)),
        textLength: page.textLength,
        htmlBytes: page.htmlBytes,
      });
    }
  }

  // Structure
  if (page.isIndexable && page.links.length === 0) {
    report("no-outgoing-links");
  }

  return issues;
}
