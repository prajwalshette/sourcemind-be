// src/services/site-crawler.service.ts
// Multi-page site crawler — discovers all pages, ingests each as its own Document.

import { logger } from "@utils/logger";
import { config } from "@config/env";
import { Document } from "@generated/prisma";
import { prisma } from "@utils/prisma";
import { normalizeUrl, hashText } from "@utils/sanitize";

export interface SiteCrawlOptions {
  maxPages?: number;
  concurrency?: number;
  sameDomainOnly?: boolean;
  excludePatterns?: string[];
}

export interface SiteCrawlResult {
  startUrl: string;
  discoveredUrls: string[];
  successCount: number;
  failedCount: number;
  skippedCount: number;
  totalChunks: number;
  totalTokens: number;
  durationMs: number;
}

const DEFAULT_EXCLUDE = [
  /\/login/i,
  /\/signup/i,
  /\/register/i,
  /\/checkout/i,
  /\/cart/i,
  /\/account/i,
  /\/admin/i,
  /\/dashboard/i,
  /\.(pdf|zip|png|jpg|jpeg|gif|svg|css|js|woff|woff2|ttf|ico)$/i,
  /#/,
];

const g: any = globalThis;

export async function crawlSite(
  startUrl: string,
  options: SiteCrawlOptions = {},
  ingestFn: (url: string) => Promise<{
    chunkCount: number;
    tokenCount: number;
    status: string;
  }>,
): Promise<SiteCrawlResult> {
  const start = Date.now();
  const normalizedStartUrl = normalizeUrl(startUrl);

  const {
    maxPages = 50,
    concurrency = 5,
    sameDomainOnly = true,
    excludePatterns = [],
  } = options;

  const domain = new g.URL(startUrl).hostname;
  logger.info(
    { startUrl, domain, maxPages, concurrency },
    "Starting site crawl",
  );

  const allUrls = await discoverAllUrls(
    normalizedStartUrl,
    domain,
    maxPages,
    sameDomainOnly,
    excludePatterns,
  );
  logger.info({ count: allUrls.length }, "URLs discovered");

  const urlHashes = allUrls.map((u) => hashText(u));
  const existing = await prisma.document.findMany({
    where: { urlHash: { in: urlHashes }, status: "INDEXED" },
    select: { urlHash: true },
  });
  const alreadyIndexed = new Set(existing.map((d: Pick<Document, 'urlHash'>) => d.urlHash));

  const toIngest = allUrls.filter((u) => !alreadyIndexed.has(hashText(u)));
  const skippedCount = allUrls.length - toIngest.length;

  logger.info(
    { total: allUrls.length, toIngest: toIngest.length, skipped: skippedCount },
    "Filtered already-indexed pages",
  );

  let successCount = 0;
  let failedCount = 0;
  let totalChunks = 0;
  let totalTokens = 0;

  for (let i = 0; i < toIngest.length; i += concurrency) {
    const batch = toIngest.slice(i, i + concurrency);
    logger.info(
      {
        batch: Math.floor(i / concurrency) + 1,
        total: Math.ceil(toIngest.length / concurrency),
        urls: batch,
      },
      "Processing batch",
    );

    const results = await Promise.allSettled(batch.map((url) => ingestFn(url)));

    for (const [j, result] of results.entries()) {
      const url = batch[j];
      if (result.status === "fulfilled") {
        successCount++;
        totalChunks += result.value.chunkCount;
        totalTokens += result.value.tokenCount;
        logger.debug(
          { url, chunks: result.value.chunkCount },
          "Page ingested",
        );
      } else {
        failedCount++;
        logger.warn(
          { url, error: (result as PromiseRejectedResult).reason?.message },
          "Page ingest failed",
        );
      }
    }

    if (i + concurrency < toIngest.length) {
      await new Promise((r) => g.setTimeout(r, 500));
    }
  }

  const durationMs = Date.now() - start;
  logger.info(
    {
      successCount,
      failedCount,
      skippedCount,
      totalChunks,
      totalTokens,
      durationMs,
    },
    "Site crawl complete",
  );

  return {
    startUrl: normalizedStartUrl,
    discoveredUrls: allUrls,
    successCount,
    failedCount,
    skippedCount,
    totalChunks,
    totalTokens,
    durationMs,
  };
}

async function discoverAllUrls(
  startUrl: string,
  domain: string,
  maxPages: number,
  sameDomainOnly: boolean,
  extraExcludes: string[],
): Promise<string[]> {
  const excludeRegexes = [
    ...DEFAULT_EXCLUDE,
    ...extraExcludes.map((p) => new RegExp(p, "i")),
  ];

  const isAllowed = (url: string): boolean => {
    try {
      const u = new g.URL(url);
      if (sameDomainOnly && u.hostname !== domain) return false;
      return !excludeRegexes.some((re) => re.test(url));
    } catch {
      return false;
    }
  };

  const sitemapUrls = await trySitemap(
    startUrl,
    domain,
    maxPages,
    isAllowed,
  );
  if (sitemapUrls.length >= 3) {
    logger.info({ count: sitemapUrls.length }, "URLs from sitemap.xml");
    return sitemapUrls.slice(0, maxPages);
  }

  logger.info("No sitemap found — using link crawl");
  return await linkCrawlUrls(startUrl, domain, maxPages, isAllowed);
}

async function trySitemap(
  startUrl: string,
  domain: string,
  maxPages: number,
  isAllowed: (url: string) => boolean,
): Promise<string[]> {
  const base = new g.URL(startUrl).origin;
  const candidates = [
    `${base}/sitemap.xml`,
    `${base}/sitemap_index.xml`,
    `${base}/sitemap/sitemap.xml`,
  ];

  for (const sitemapUrl of candidates) {
    try {
      const res = await g.fetch(sitemapUrl, {
        signal: g.AbortSignal.timeout(8_000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RAGBot/1.0)" },
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1].trim())
        .filter((url) => url.startsWith("http") && isAllowed(url));
      if (locs.length > 0) return locs.slice(0, maxPages);
    } catch {
      // try next
    }
  }
  return [];
}

async function linkCrawlUrls(
  startUrl: string,
  domain: string,
  maxPages: number,
  isAllowed: (url: string) => boolean,
): Promise<string[]> {
  const normalizedStart = normalizeUrl(startUrl);
  const discovered = new Set<string>([normalizedStart]);
  const queue: string[] = [normalizedStart];
  const visited = new Set<string>();

  while (queue.length > 0 && discovered.size < maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const links = await extractLinks(url, domain);
    for (const link of links) {
      const clean = normalizeUrl(link);
      if (!discovered.has(clean) && isAllowed(clean)) {
        discovered.add(clean);
        if (discovered.size < maxPages) queue.push(clean);
      }
    }

    if (queue.length > 0) {
      await new Promise((r) => g.setTimeout(r, 100));
    }
  }

  return [...discovered].slice(0, maxPages);
}

async function extractLinks(url: string, domain: string): Promise<string[]> {
  try {
    const res = await g.fetch(url, {
      signal: g.AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RAGBot/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const links = extractLinksFromHtml(html, url, domain);
    if (links.length < 5 && html.length > 3000) {
      return await extractLinksWithPlaywright(url, domain);
    }
    return links;
  } catch {
    // fall through
  }
  return await extractLinksWithPlaywright(url, domain);
}

function extractLinksFromHtml(
  html: string,
  baseUrl: string,
  domain: string,
): string[] {
  const base = new g.URL(baseUrl).origin;
  const links: string[] = [];
  const hrefRegex = /href=["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1].trim();
    try {
      const abs = href.startsWith("http")
        ? href
        : `${base}${href.startsWith("/") ? "" : "/"}${href}`;
      const normalized = normalizeUrl(abs);
      const u = new g.URL(normalized);
      if (u.hostname === domain) links.push(normalized);
    } catch {
      // skip
    }
  }
  return [...new Set(links)];
}

async function extractLinksWithPlaywright(
  url: string,
  domain: string,
): Promise<string[]> {
  try {
    const pw: any = (g as any).playwright;
    if (!pw) {
      throw new Error(
        "Playwright not available on globalThis. Install and wire it in your runtime if you need link discovery.",
      );
    }
    const browser = await pw.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    try {
      const ctx = await browser.newContext({
        userAgent: "Mozilla/5.0 (compatible; RAGBot/1.0)",
      });
      const page = await ctx.newPage();
      await page.route("**/*", (r: any) =>
        ["image", "font", "media", "stylesheet"].includes(
          r.request().resourceType(),
        )
          ? r.abort()
          : r.continue(),
      );
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await page.waitForTimeout(1_000);

      const links: string[] = await page.evaluate((d: string) => {
        return Array.from(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (globalThis as any).document.querySelectorAll("a[href]") as any[],
        )
          .map((a: any) => a.href as string)
          .filter((href: string) => {
            try {
              return (
                new (globalThis as any).URL(href).hostname === d &&
                !href.includes("#")
              );
            } catch {
              return false;
            }
          });
      }, domain);

      await ctx.close();
      return [...new Set(links)];
    } finally {
      await browser.close();
    }
  } catch (err) {
    logger.warn(
      { url, error: (err as Error).message },
      "Playwright link extract failed",
    );
    return [];
  }
}

