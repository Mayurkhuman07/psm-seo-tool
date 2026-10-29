# Plan: Replacing DataForSEO With Our Own Data Layer

Status: research / proposal. Nothing here is implemented yet.

## 1. What we are actually replacing

DataForSEO is not a thin dependency in this codebase. Measured surface:

- **37 distinct API endpoints** called across 7 data families
- **~7,500 LOC** in `src/server/lib/dataforseo/`
- **236 files** mention `dataforseo`
- **~24 real consumer modules** call `createDataforseoClient` (the rest are tests/types)

The good news: there *is* a clean seam. Almost everything funnels through
`createDataforseoClient` (`src/server/lib/dataforseo/client.ts`) plus a handful of
free "task result" fetchers exported from `index.ts`. That is the interface to
reimplement against — not 236 files.

## 2. What is ALREADY ours (no work needed)

These features do not touch DataForSEO at all and keep working as-is:

| Capability | Where | Notes |
|---|---|---|
| Site crawler | `src/server/lib/audit/discovery.ts` | Own crawler: robots.txt, throttling, redirect chains, crawl windows |
| Technical SEO checks | `src/server/lib/audit/issues/` | ~30 check types: titles, meta, H1s, canonicals, thin/duplicate content, broken pages, redirect loops, alt text, heading order |
| Page analysis | `src/server/lib/audit/page-analyzer.ts` | HTML parsing, content extraction |
| Google Search Console | `src/server/features/gsc/` | Free, first-party, **exact** impressions/clicks/CTR/position |
| Google Analytics 4 | `src/server/features/ga4/` | Free, first-party traffic data |
| IndexNow | `src/server/features/indexnow/` | Free submission |

**This is the single most important finding.** GSC already gives exact query,
impression, click and average-position data for any site the user owns — for
free, legally, with no scraping. A large share of what people buy an SEO tool
for is already available without DataForSEO.

## 3. The seven families to replace — honest verdict

| # | Family | Endpoints | Difficulty | Verdict |
|---|---|---|---|---|
| 1 | Lighthouse / page speed | 1 | **Easy** | Drop-in free replacement |
| 2 | AI visibility (LLM mentions) | 6 | **Easy** | Call the LLM APIs ourselves |
| 3 | Keyword volume / CPC | 2 | **Medium** | Google Ads API, gated |
| 4 | Keyword ideas / related / suggestions | 6 | **Medium** | Derive from GSC + Ads + autocomplete |
| 5 | SERP + rank tracking | 6 | **Hard** | Scrape or buy. Legal + cost exposure |
| 6 | Backlinks | 5 | **Very hard** | Domain-level only, realistically |
| 7 | Business / local (GBP, maps) | 6 | **Hard** | Places API is paid; map ranks need scraping |

### 3.1 Lighthouse — solved

Replace `/v3/on_page/lighthouse/live/json` with Google's **PageSpeed Insights API**:
free, **25,000 requests/day** per Google Cloud project, no billing required.
It returns the same Lighthouse JSON, so the existing `dataforseoLighthousePayload.ts`
normalisation largely survives. Rolling limit is roughly 400 queries/100s.

### 3.2 AI visibility — solved, and cheaper

DataForSEO's `ai_optimization/*` endpoints just proxy ChatGPT/Gemini and
aggregate brand mentions. We already depend on `@openrouter/ai-sdk-provider`
and `ai`. Call the models directly, store answers, and do the mention
aggregation ourselves — it is string matching over responses we already hold.
This removes a markup and gives us model choice.

### 3.3 Keyword volume — possible but gated

**Google Ads API KeywordPlanIdeaService** is the only free source of real
Google search volume and CPC. Constraints found in research:

- Requires a Google Ads account and **Basic access** level.
- The new **Explorer** tier (Feb 2026) explicitly *excludes* KeywordPlanService
  and KeywordPlanIdeaService — Explorer is not enough.
- Developer tokens were **sunset 9 Sept 2026**; access level now follows the
  Google Cloud project, and Basic access now requires **brand verification**.
- Volumes come back **bucketed** (ranges), not exact, unless the account has
  active spend.

Supplementary free signals: **Google Trends** (relative only), **autocomplete /
"People also ask"** harvesting for ideas, and **GSC** for the user's own exact
query data.

### 3.4 SERP / rank tracking — the first real wall

There is no free, legitimate API for "what ranks #1 for X in Mumbai".
Three options:

1. **GSC only (compliant).** Use average position from Search Console. Exact,
   free, legal — but *only for sites the user owns*, and no competitor ranks.
2. **Self-hosted scraping.** Residential proxies at ~$1–7/GB (datacenter ~$0.50/GB,
   but far higher block rates). You own CAPTCHA handling, layout drift, and
   per-location/per-language rendering. Google's ToS prohibits automated
   querying; there is active litigation in this space (Google v. SerpApi, 2026 —
   core DMCA claims dismissed July 2026, but the case is a signal, not a
   green light). **This is a business/legal decision, not a technical one.**
3. **Buy a cheaper SERP API.** Oxylabs ~$2–4 per 1,000 searches vs ScraperAPI
   ~$12 and SerpApi ~$5.50–25. Swapping DataForSEO for a cheaper SERP vendor
   is far less work than self-hosting and may be the pragmatic answer.

### 3.5 Backlinks — the hardest problem

Ahrefs/Majestic maintain continuous web-scale crawls. We cannot.

Realistic option: **Common Crawl's webgraph**. Research findings:

- Three files: domain→ID, edges, ranks. Edges file ~**16 GB**.
- Processable in DuckDB on one machine; one builder did gap analysis for free.
- Full-page processing of all 2.8B pages ran ~**$100** in EC2 time.

Hard limitations you must accept:

- **Domain-level only** — "A links to B". No source page URL, no anchor text,
  no dofollow/nofollow.
- **Quarterly snapshot**, not live. New links appear months late or never.
- Hosting-platform noise inflates counts badly.

Free supplements: **Bing Webmaster Tools API** (`GetLinkCounts`, `GetUrlLinks`)
gives real inbound-link data, but **only for sites the user has verified** —
so it covers your own site, not competitors. Also **Open PageRank** for free
domain authority scores.

**Recommendation: do not promise competitor backlink parity.** Ship domain-level
gap analysis from Common Crawl + exact own-site links from Bing/GSC, and label
it honestly in the UI.

### 3.6 Local / Google Business Profile

- Business info/reviews/Q&A → **Google Places API (New)** — real, but **paid**
  per call, and review access is limited to 5 reviews per place.
- Map-pack rank by coordinate → no legitimate API. Same scraping problem as 3.4.

## 4. Proposed architecture

Introduce a provider abstraction so no feature code imports a vendor again.

```
src/server/lib/seo-data/
  types.ts                 # vendor-neutral domain types
  provider.ts              # SeoDataProvider interface
  registry.ts              # per-capability provider selection + fallback
  providers/
    psi/                   # PageSpeed Insights  -> lighthouse
    google-ads/            # Keyword Planner     -> volume, ideas
    gsc/                   # Search Console      -> own-site ranks, queries
    bing-wmt/              # Bing Webmaster      -> own-site backlinks
    common-crawl/          # webgraph            -> domain-level backlinks
    llm/                   # OpenRouter etc.     -> AI visibility
    places/                # Google Places       -> local business data
    serp/                  # pluggable: scraper OR third-party vendor
    dataforseo/            # keep as one provider among many
```

Design rules:

- Every capability returns a **vendor-neutral type** plus a `source` and
  `confidence`/`freshness` field, because our replacements are genuinely less
  precise than DataForSEO and the UI must say so.
- The registry allows **per-capability** selection, so a user can self-host
  everything except SERP and still buy SERP from a vendor.
- Keep `dataforseo/` as one implementation. Do not delete it — make it optional.
  This also keeps the existing tests meaningful during migration.

### Infrastructure reality check

The app currently runs on **Cloudflare Workers + D1**. That is fine for PSI,
Ads, GSC, Bing and LLM calls. It is **not** adequate for:

- Common Crawl processing (16 GB joins) → needs **R2 + a real VM/container**,
  with results loaded back into D1/Postgres as a precomputed table.
- Sustained SERP scraping → needs long-running processes, proxy pools and
  CAPTCHA handling, which Workers are a poor fit for.

So self-hosting the data layer implies **adding a worker machine** outside
Cloudflare, or moving to the Postgres backend the repo already supports
(`docs/LOCAL_POSTGRES.md`).

## 5. Phased plan

**Phase 0 — abstraction (no behaviour change)**
Define `SeoDataProvider`, move the DataForSEO client behind it, keep output
identical, keep tests green. This de-risks everything after it.

**Phase 1 — free wins** *(removes real cost immediately)*

- PageSpeed Insights provider → replaces Lighthouse
- LLM provider → replaces all 6 `ai_optimization` endpoints
- Lean harder on GSC for own-site position/query data

**Phase 2 — keyword data**

- Google Ads API provider (volume, CPC, ideas)
- Autocomplete/PAA harvesting for suggestions
- Blend with GSC; surface "bucketed" vs "exact" in the UI

**Phase 3 — backlinks (reduced scope, stated honestly)**

- Common Crawl webgraph ingestion job → precomputed domain-level table
- Bing Webmaster provider for verified own-site links
- Open PageRank for authority scores

**Phase 4 — SERP decision point**
Pick one: GSC-only, self-hosted scraping, or a cheaper SERP vendor. Do not
start this before Phases 0–3 are done; it is the highest-risk piece and the
others deliver value without it.

**Phase 5 — local SEO**
Google Places provider; map-pack ranks only if Phase 4 chose scraping.

## 6. Requirements checklist

**Accounts / keys**

- [ ] Google Cloud project — PageSpeed Insights API key *(free)*
- [ ] Google Cloud OAuth client — GSC + GA4 *(free; partly configured already)*
- [ ] Google Ads account with **Basic** API access + brand verification *(free, gated)*
- [ ] OpenRouter (or OpenAI/Anthropic/Gemini) key — AI visibility *(paid per token)*
- [ ] Bing Webmaster Tools API key *(free)*
- [ ] Google Places API key *(paid per call)* — only if local SEO is kept
- [ ] Proxy provider *(paid)* — only if SERP scraping is chosen

**Infrastructure**

- [ ] R2 bucket or equivalent for Common Crawl artifacts
- [ ] A non-Workers machine for batch jobs (Common Crawl, scraping)
- [ ] DuckDB or ClickHouse for webgraph joins
- [ ] Decide D1 vs Postgres for the precomputed backlink tables

**Product decisions needed from you**

- [ ] Is competitor rank tracking in scope at all, or is own-site (GSC) enough?
- [ ] Are we willing to scrape Google, accepting the ToS/legal exposure?
- [ ] Can we accept domain-level-only backlinks with no anchor text?
- [ ] Is "cheaper vendor" acceptable, or must it be fully self-hosted?

## 7. Honest summary

- **~40% of the value is already self-hosted** (audit, crawler, GSC, GA4).
- **Another ~25% is easy to take back** (Lighthouse, AI visibility) — do this first.
- **~20% is gated but doable** (keyword data via Google Ads).
- **~15% — competitor SERP ranks and page-level backlinks — cannot be fully
  self-hosted at acceptable cost or risk.** Any plan claiming otherwise is
  overselling.

The realistic end state is **not** "zero third-party data". It is "no DataForSEO,
free/first-party sources wherever they exist, and one narrow paid dependency for
SERP if competitor tracking stays in scope."

---

# Implementation log

## Native on-page checks (built, no API dependency)

DataForSEO's On-Page API was used only as a *specification* of what to detect —
its 62 documented `checks` booleans. None of its endpoints are called. Every
check below runs on our own crawler output, inside the existing audit engine.

Added to `src/server/lib/audit/`:

| Issue id | Severity | Detects |
|---|---|---|
| `insecure-page` | critical | Page served over plain HTTP |
| `lorem-ipsum` | critical | Placeholder copy left in production |
| `frame-usage` | critical | `<frame>` / `<frameset>` |
| `mixed-content-links` | warning | HTTPS page linking out over HTTP |
| `meta-refresh-redirect` | warning | `<meta http-equiv="refresh">` instead of a 301 |
| `no-doctype` | warning | Missing `<!DOCTYPE html>` (quirks mode) |
| `no-charset-declaration` | warning | No `<meta charset>` or http-equiv equivalent |
| `duplicate-title-tag` | warning | More than one document-level `<title>` |
| `large-page-size` | warning | HTML over 1 MB |
| `no-favicon` | info | No `rel="icon"` (entry point only) |
| `low-text-ratio` | info | Visible text under 10% of HTML |
| `deprecated-html-tags` | info | `<font>`, `<center>`, `<marquee>`, … |
| `non-seo-friendly-url` | info | Dynamic params, non-Latin/underscore chars, long path |

### How it works

All thirteen signals come out of the **existing single tokenizer pass** in
`page-analyzer.ts`. No second parse, no DOM, no extra fetch — the analyzer was
already streaming the HTML, so these are counters and booleans accumulated
alongside the fields it already extracted. That matters: the audit engine runs
on a 128 MB Worker isolate and a DOM parse per page was its historical OOM
cause.

New `PageAnalysis` / `CrawledPageResult` fields: `hasDoctype`,
`charsetDeclared`, `metaRefresh`, `titleTagCount`, `hasFavicon`, `hasFrames`,
`deprecatedTags`, `textLength`, `hasLoremIpsum`. They are transient like
`isHtml` — reporter input, not persisted columns, so no migration.

Checks are split into `documentHygieneIssues()` (markup and URL level) and the
existing content checks. The split is deliberate, not just to satisfy the
complexity limit: hygiene checks stay valid for an unrendered JavaScript shell,
where any claim about the page's copy would be wrong.

### Deliberate deviations from the DataForSEO spec

- **`no-favicon` fires only on the entry point.** A favicon is a site-wide
  fact; one row per URL would bury the report. DataForSEO reports it per page.
- **`low-text-ratio` skips documents under 2 KB.** The ratio swings on a few
  bytes for tiny pages, which makes it noise rather than signal.
- **Spelling (`has_misspelling`) and relevance checks
  (`irrelevant_title`/`irrelevant_description`) were not built.** Spelling needs
  per-language dictionaries; relevance needs an embedding model. Both are real
  work, not oversights — they are the honest next candidates.
- **Readability (`low_readability_rate`) not built.** Flesch–Kincaid needs
  syllable counting that is English-only; applying it to every page would
  mislabel non-English sites.

### Verification status

- Unit tests: added to `page-reporters.test.ts` (reporter behaviour) and
  `page-analyzer.test.ts` (extraction).
- The analyzer's cheerio parity test now compares only the fields the retired
  DOM implementation produced; the new signals are outside that contract, as
  `javascriptShell` already was.
- **Not yet verified:** the `tests/badseo` end-to-end harness asserts an exact
  issue set per fixture page, so new checks firing on existing fixtures would
  surface as `extra:` failures there. That harness must be run before this is
  considered done.
