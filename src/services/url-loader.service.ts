

import * as cheerio from "cheerio";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { validateUrl, sanitizeContent } from "@utils/sanitize";
import { logger } from "@utils/logger";
import { config } from "@config/env";
import type { LoadedDocument } from "@interfaces/ingestion.interface";

export interface LoadOptions {
  crawlAllPages?: boolean;
  maxPages?: number;
}

const BOT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; RAGBot/1.0)",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

// ─── MAIN ENTRY POINT ────────────────────────────────────────────────────────
export async function loadUrl(
  url: string,
  options: LoadOptions = {},
): Promise<LoadedDocument> {
  await validateUrl(url);
  const { crawlAllPages = false, maxPages = 20 } = options;
  logger.debug({ url, crawlAllPages, maxPages }, "Loading URL");

  // TIER 1: Crawl4AI (best quality markdown, AI-aware, handles JS)
  if (config.CRAWL4AI_BASE_URL) {
    try {
      const result = crawlAllPages
        ? await crawl4aiCrawlSite(url, maxPages)
        : await crawl4aiSingle(url);
      if (result.wordCount >= 50) {
        logger.info(
          { url, wordCount: result.wordCount, pagesCrawled: result.pagesCrawled },
          "Crawl4AI loaded",
        );
        return result;
      }
    } catch (err) {
      logger.warn(
        { url, err: (err as Error).message },
        "Crawl4AI failed — trying Cheerio",
      );
    }
  }

  // TIER 2: Cheerio (fast, static HTML)
  // BUG FIX: JS-rendered doc sites (MkDocs, Docusaurus, etc.) only return nav HTML
  // to Cheerio. The old threshold (>= 50 words) let that nav HTML through, so RAG
  // indexed just a list of links. We now:
  //   1) Skip Cheerio entirely for known JS doc hosts.
  //   2) Require >= 200 words AND content not nav-only before accepting.
  if (!crawlAllPages) {
    const isJsDoc = isKnownJsDocSite(url);
    if (isJsDoc) {
      logger.info(
        { url },
        "Cheerio skipped — known JS-rendered doc site, will use JS-capable loader",
      );
    } else {
      try {
        const result = await loadWithCheerio(url);
        if (result.wordCount >= 200 && !isNavOnlyContent(result.content)) {
          logger.info(
            { url, wordCount: result.wordCount },
            "Cheerio loaded",
          );
          return { ...result, loader: "cheerio", pagesCrawled: 1 };
        }
        logger.warn(
          { url, wordCount: result.wordCount },
          "Cheerio content looks like nav-only HTML — trying JS-capable loader",
        );
      } catch (err) {
        logger.warn(
          { url, err: (err as Error).message },
          "Cheerio failed — trying JS-capable loader",
        );
      }
    }
  }

  // TIER 3: Firecrawl (JS SPAs + full-site crawl)
  if (config.FIRECRAWL_API_KEY) {
    try {
      const result = crawlAllPages
        ? await firecrawlCrawlSite(url, maxPages)
        : await firecrawlSingle(url);
      logger.info(
        { url, wordCount: result.wordCount, pagesCrawled: result.pagesCrawled },
        "Firecrawl loaded",
      );
      return result;
    } catch (err) {
      logger.warn(
        { url, err: (err as Error).message },
        "Firecrawl failed — trying Playwright",
      );
    }
  } else {
    logger.warn("FIRECRAWL_API_KEY not set — skipping Firecrawl");
  }

  // TIER 4: Playwright (local headless Chrome)
  // BUG FIX: When crawlAllPages=true and Crawl4AI/Firecrawl are unavailable,
  // we need a JS-capable full-site crawler. Playwright can now spider the site:
  // discover internal links and crawl them recursively.
  try {
    const result = crawlAllPages
      ? await playwrightCrawlSite(url, maxPages)
      : await loadWithPlaywright(url);
    logger.info(
      {
        url,
        wordCount: result.wordCount,
        pagesCrawled: (result as any).pagesCrawled ?? 1,
      },
      "Playwright loaded",
    );
    return crawlAllPages
      ? (result as LoadedDocument)
      : { ...(result as any), loader: "playwright", pagesCrawled: 1 };
  } catch (err) {
    throw new Error(
      `All loaders failed for ${url}.\n` +
        `  • Crawl4AI: ${
          config.CRAWL4AI_BASE_URL ? "service error" : "not configured (set CRAWL4AI_BASE_URL)"
        }\n` +
        `  • Cheerio: JS-rendered page (SPA / docs site)\n` +
        `  • Firecrawl: ${
          config.FIRECRAWL_API_KEY ? "API error" : "no key (set FIRECRAWL_API_KEY)"
        }\n` +
        `  • Playwright: ${(err as Error).message}`,
    );
  }
}

// ─── TIER 1A: CRAWL4AI SINGLE PAGE ───────────────────────────────────────────
async function crawl4aiSingle(url: string): Promise<LoadedDocument> {
  const base = config.CRAWL4AI_BASE_URL.replace(/\/$/, "");

  const response = await fetch(`${base}/crawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urls: [url],
      priority: 10,
      crawler_params: {
        headless: true,
        page_timeout: 30000,
        wait_for_images: false,
        remove_overlay_elements: true,
        simulate_user: true,
        magic: true,
      },
      extra: {
        word_count_threshold: 10,
        excluded_tags: ["nav", "footer", "header", "aside", "form"],
        exclude_external_links: true,
        remove_forms: true,
        process_iframes: false,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(
      `Crawl4AI error ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    results?: Array<{
      url: string;
      markdown?: { raw_markdown?: string; fit_markdown?: string };
      metadata?: { title?: string; description?: string };
      success: boolean;
      error_message?: string;
    }>;
    task_id?: string;
  };

  if (data.task_id && !data.results) {
    return await pollCrawl4aiTask(base, data.task_id, url, false);
  }

  const result = data.results?.[0];
  if (!result?.success) {
    throw new Error(`Crawl4AI extraction failed: ${result?.error_message}`);
  }

  const markdown =
    result.markdown?.fit_markdown || result.markdown?.raw_markdown || "";
  const cleaned = sanitizeContent(markdown);
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  const title = result.metadata?.title || new URL(url).hostname;
  const parsed = new URL(url);

  return {
    url,
    title: title.slice(0, 500),
    content: cleaned,
    contentType: "markdown",
    wordCount,
    loader: "crawl4ai",
    pagesCrawled: 1,
    metadata: {
      url,
      title: title.slice(0, 500),
      description: (result.metadata?.description || "").slice(0, 1000),
      domain: parsed.hostname,
      crawledAt: new Date().toISOString(),
      loader: "crawl4ai",
    },
  };
}

// ─── TIER 1B: CRAWL4AI FULL SITE ─────────────────────────────────────────────
async function crawl4aiCrawlSite(
  startUrl: string,
  maxPages: number,
): Promise<LoadedDocument> {
  const base = config.CRAWL4AI_BASE_URL.replace(/\/$/, "");
  const domain = new URL(startUrl).hostname;

  const response = await fetch(`${base}/crawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urls: [startUrl],
      priority: 10,
      crawler_params: {
        headless: true,
        page_timeout: 30000,
        magic: true,
        deep_crawl: true,
        deep_crawl_config: {
          strategy: "bfs",
          max_depth: 3,
          max_pages: maxPages,
          include_patterns: [`${domain}/*`],
          exclude_patterns: ["*/login*", "*/signup*", "*/checkout*", "*#*"],
        },
      },
      extra: {
        word_count_threshold: 10,
        excluded_tags: ["nav", "footer", "header", "aside", "form"],
        remove_forms: true,
      },
    }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    throw new Error(`Crawl4AI deep crawl error ${response.status}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      url: string;
      markdown?: { fit_markdown?: string; raw_markdown?: string };
      metadata?: { title?: string };
      success: boolean;
    }>;
    task_id?: string;
  };

  if (data.task_id && !data.results) {
    return await pollCrawl4aiTask(base, data.task_id, startUrl, true);
  }

  return mergeMultiPageResults(data.results || [], startUrl, "crawl4ai");
}

async function pollCrawl4aiTask(
  base: string,
  taskId: string,
  url: string,
  multi: boolean,
): Promise<LoadedDocument> {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${base}/task/${taskId}`);
    if (!res.ok) continue;

    const data = (await res.json()) as {
      status: string;
      results?: Array<{
        url: string;
        markdown?: { fit_markdown?: string; raw_markdown?: string };
        metadata?: { title?: string };
        success: boolean;
      }>;
    };

    if (data.status === "completed" && data.results) {
      if (multi) return mergeMultiPageResults(data.results, url, "crawl4ai");

      const r = data.results[0];
      const md = r?.markdown?.fit_markdown || r?.markdown?.raw_markdown || "";
      const cleaned = sanitizeContent(md);
      const parsed = new URL(url);

      return {
        url,
        title: r?.metadata?.title || url,
        content: cleaned,
        contentType: "markdown",
        wordCount: cleaned.split(/\s+/).filter(Boolean).length,
        loader: "crawl4ai",
        pagesCrawled: 1,
        metadata: {
          url,
          domain: parsed.hostname,
          crawledAt: new Date().toISOString(),
          loader: "crawl4ai",
        },
      };
    }

    if (data.status === "failed") throw new Error("Crawl4AI task failed");
  }

  throw new Error("Crawl4AI task timed out after 60s");
}

// ─── TIER 1: CHEERIO (static HTML) ───────────────────────────────────────────
async function loadWithCheerio(
  url: string,
): Promise<Omit<LoadedDocument, "loader" | "pagesCrawled">> {
  const response = await fetch(url, {
    headers: BOT_HEADERS,
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = response.headers.get("content-type") || "";
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("text/plain")
  ) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const html = await response.text();
  return parseHtml(html, url);
}

// ─── TIER 3A: FIRECRAWL SINGLE PAGE ──────────────────────────────────────────
async function firecrawlSingle(url: string): Promise<LoadedDocument> {
  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      waitFor: 2000,
      timeout: 30000,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    throw new Error(
      `Firecrawl scrape error ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    success: boolean;
    data?: { markdown?: string; metadata?: { title?: string; description?: string; ogTitle?: string } };
    error?: string;
  };

  if (!data.success || !data.data?.markdown) {
    throw new Error(`Firecrawl: ${data.error || "no content"}`);
  }

  const cleaned = sanitizeContent(data.data.markdown);
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  const title =
    data.data.metadata?.ogTitle ||
    data.data.metadata?.title ||
    new URL(url).hostname;
  const parsed = new URL(url);

  return {
    url,
    title: title.slice(0, 500),
    content: cleaned,
    contentType: "markdown",
    wordCount,
    loader: "firecrawl",
    pagesCrawled: 1,
    metadata: {
      url,
      title: title.slice(0, 500),
      description: (data.data.metadata?.description || "").slice(0, 1000),
      domain: parsed.hostname,
      crawledAt: new Date().toISOString(),
      loader: "firecrawl",
    },
  };
}

// ─── TIER 3B: FIRECRAWL FULL SITE CRAWL ──────────────────────────────────────
async function firecrawlCrawlSite(
  startUrl: string,
  maxPages: number,
): Promise<LoadedDocument> {
  const crawlRes = await fetch("https://api.firecrawl.dev/v1/crawl", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: startUrl,
      limit: maxPages,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      excludePaths: ["/login", "/signup", "/checkout", "/cart", "/account"],
      maxDepth: 3,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!crawlRes.ok) {
    throw new Error(
      `Firecrawl crawl start error ${crawlRes.status}: ${await crawlRes.text()}`,
    );
  }

  const { id: crawlId } = (await crawlRes.json()) as { id: string };
  logger.info({ crawlId, startUrl }, "Firecrawl crawl started");

  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(
      `https://api.firecrawl.dev/v1/crawl/${crawlId}`,
      { headers: { Authorization: `Bearer ${config.FIRECRAWL_API_KEY}` } },
    );
    if (!statusRes.ok) continue;

    const status = (await statusRes.json()) as {
      status: "scraping" | "completed" | "failed";
      completed: number;
      total: number;
      data?: Array<{
        markdown?: string;
        metadata?: { title?: string; sourceURL?: string };
      }>;
    };

    logger.debug(
      { crawlId, completed: status.completed, total: status.total },
      "Firecrawl crawl progress",
    );

    if (status.status === "completed" && status.data) {
      return mergeMultiPageResults(
        status.data.map((d) => ({
          url: d.metadata?.sourceURL || startUrl,
          markdown: { fit_markdown: d.markdown },
          metadata: { title: d.metadata?.title },
          success: !!d.markdown,
        })),
        startUrl,
        "firecrawl",
      );
    }
    if (status.status === "failed") throw new Error("Firecrawl crawl job failed");
  }

  throw new Error("Firecrawl crawl timed out");
}

// ─── TIER 4: PLAYWRIGHT (headless Chrome) ───────────────────────────────────
// Requires: npx playwright install chromium
async function loadWithPlaywright(
  url: string,
): Promise<Omit<LoadedDocument, "loader" | "pagesCrawled">> {
  type PwBrowser = {
    newContext: (opts: object) => Promise<PwContext>;
    close: () => Promise<void>;
  };
  type PwContext = {
    newPage: () => Promise<PwPage>;
    close: () => Promise<void>;
  };
  type PwPage = {
    goto: (u: string, opts: object) => Promise<unknown>;
    content: () => Promise<string>;
  };

  let chromium: { launch: (opts: object) => Promise<PwBrowser> };
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    throw new Error(
      "Playwright not installed. Run: npm install playwright && npx playwright install chromium",
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
    ],
  });

  try {
    const context: PwContext = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const page: PwPage = await context.newPage();

    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 2000));

    const html = await page.content();
    await context.close();

    const result = parseHtml(html, url);
    return result;
  } finally {
    await browser.close();
  }
}

// ─── PLAYWRIGHT FULL-SITE CRAWLER (JS docs, crawlAllPages=true) ──────────────
async function playwrightCrawlSite(
  startUrl: string,
  maxPages: number,
): Promise<LoadedDocument> {
  let chromium: any;
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    throw new Error(
      "Playwright not installed. Run: npm install playwright && npx playwright install chromium",
    );
  }

  const domain = new URL(startUrl).hostname;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const visited = new Set<string>();
  const queue: string[] = [startUrl];
  const pages: Array<{ url: string; content: string; title: string }> = [];

  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (compatible; RAGBot/1.0; +https://github.com/URL-RAG)",
      viewport: { width: 1280, height: 800 },
    });

    while (queue.length > 0 && pages.length < maxPages) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      try {
        const page = await ctx.newPage();
        await page.route("**/*", (r: any) =>
          ["image", "font", "media", "stylesheet"].includes(
            r.request().resourceType(),
          )
            ? r.abort()
            : r.continue(),
        );
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
        await page.waitForTimeout(1500);

        const title = await page.title();
        const html = await page.content();
        await page.close();

        const parsed = parseHtml(html, url);
        if (parsed.wordCount >= 150 && !isNavOnlyContent(parsed.content)) {
          pages.push({
            url,
            content: parsed.content,
            title: title || parsed.title,
          });
          logger.debug(
            { url, wordCount: parsed.wordCount },
            "Playwright crawled page",
          );
        }

        if (pages.length < maxPages) {
          const linkPage = await ctx.newPage();
          await linkPage.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          });
          const links: string[] = await linkPage.evaluate((host: string) => {
            const anchors = Array.from(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (globalThis as any).document.querySelectorAll("a[href]") as any[],
            );
            return anchors
              .map((a) => a.href as string)
              .filter((href) => {
                try {
                  const u = new URL(href);
                  return (
                    u.hostname === host &&
                    !href.includes("#") &&
                    !href.match(
                      /\.(pdf|zip|png|jpg|jpeg|gif|svg|css|js)$/i,
                    )
                  );
                } catch {
                  return false;
                }
              });
          }, domain);
          await linkPage.close();

          for (const link of links) {
            if (!visited.has(link) && !queue.includes(link)) {
              queue.push(link);
            }
          }
        }
      } catch (err) {
        logger.warn(
          { url, error: (err as Error).message },
          "Playwright failed to crawl page",
        );
      }
    }

    await ctx.close();
  } finally {
    await browser.close();
  }

  if (pages.length === 0) {
    throw new Error(
      `Playwright site crawl: no content extracted from ${startUrl}`,
    );
  }

  const combined = pages
    .map(
      (p) =>
        `\n\n---\n<!-- Page: ${p.url} -->\n\n${p.content}`,
    )
    .join("\n");
  const cleaned = sanitizeContent(combined);
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  const title = pages[0]?.title || domain;

  return {
    url: startUrl,
    title: title.slice(0, 500),
    content: cleaned,
    contentType:
      /^#{1,6}\s/m.test(cleaned) || /```/.test(cleaned) ? "markdown" : "text",
    wordCount,
    loader: "playwright",
    pagesCrawled: pages.length,
    metadata: {
      url: startUrl,
      title: title.slice(0, 500),
      domain,
      pagesCrawled: String(pages.length),
      crawledAt: new Date().toISOString(),
      loader: "playwright",
    },
  };
}

function mergeMultiPageResults(
  pages: Array<{
    url: string;
    markdown?: { fit_markdown?: string; raw_markdown?: string };
    metadata?: { title?: string };
    success: boolean;
  }>,
  startUrl: string,
  loader: "crawl4ai" | "firecrawl",
): LoadedDocument {
  const successful = pages.filter((p) => p.success);
  const domain = new URL(startUrl).hostname;

  const combined = successful
    .map((p) => {
      const md = p.markdown?.fit_markdown || p.markdown?.raw_markdown || "";
      return `\n\n---\n<!-- Page: ${p.url} -->\n\n${md}`;
    })
    .join("\n");

  const cleaned = sanitizeContent(combined);
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  const title = successful[0]?.metadata?.title || domain;

  logger.info(
    { domain, successful: successful.length, total: pages.length },
    "Merged multi-page crawl results",
  );

  return {
    url: startUrl,
    title: title.slice(0, 500),
    content: cleaned,
    contentType: "markdown",
    wordCount,
    loader,
    pagesCrawled: successful.length,
    metadata: {
      url: startUrl,
      title: title.slice(0, 500),
      domain,
      pagesCrawled: String(successful.length),
      crawledAt: new Date().toISOString(),
      loader,
    },
  };
}

// ─── SHARED HTML PARSER (Cheerio + Playwright) ───────────────────────────────
function parseHtml(
  html: string,
  url: string,
): Omit<LoadedDocument, "loader" | "pagesCrawled"> {
  const $ = cheerio.load(html);

  $(
    [
      "script",
      "style",
      "noscript",
      "nav",
      "footer",
      "header",
      "aside",
      ".sidebar",
      ".ads",
      ".advertisement",
      ".cookie-banner",
      "#cookie-notice",
      ".popup",
      ".modal",
      "iframe",
      "form",
      '[role="navigation"]',
      '[role="banner"]',
      '[role="complementary"]',
    ].join(", "),
  ).remove();

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim() ||
    $("h1").first().text().trim() ||
    new URL(url).pathname;

  const description =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";

  const author =
    $('meta[name="author"]').attr("content") ||
    $('[rel="author"]').text().trim() ||
    "";

  const contentSelectors = [
    "main",
    "article",
    '[role="main"]',
    ".content",
    ".post-content",
    ".entry-content",
    ".article-body",
    "#content",
    ".documentation",
    ".markdown-body",
    ".prose",
  ];

  let bodyHtml = "";
  for (const selector of contentSelectors) {
    const el = $(selector);
    if (el.length && el.text().trim().length > 200) {
      bodyHtml = el.html() || "";
      break;
    }
  }
  if (!bodyHtml) bodyHtml = $("body").html() || html;

  const markdown = NodeHtmlMarkdown.translate(bodyHtml, {
    keepDataImages: false,
  });

  const cleaned = sanitizeContent(markdown);
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;

  if (wordCount < 150 || isNavOnlyContent(cleaned)) {
    throw new Error(
      `Content too thin (${wordCount} words) or nav-only. Likely JS-rendered.`,
    );
  }

  const hasMarkdownHeaders = /^#{1,6}\s/m.test(cleaned);
  const hasCodeBlocks = /```/.test(cleaned);
  const parsed = new URL(url);

  return {
    url,
    title: title.slice(0, 500),
    content: cleaned,
    contentType: hasMarkdownHeaders || hasCodeBlocks ? "markdown" : "text",
    wordCount,
    metadata: {
      url,
      title: title.slice(0, 500),
      description: description.slice(0, 1000),
      author,
      domain: parsed.hostname,
      crawledAt: new Date().toISOString(),
    },
  };
}

// ─── HELPERS: JS DOC SITE DETECTION & NAV CONTENT ────────────────────────────

function isKnownJsDocSite(url: string): boolean {
  const knownJsHosts = [
    "docs.crawl4ai.com",
    "docs.anthropic.com",
    "docs.langchain.com",
    "js.langchain.com",
    "docs.qdrant.tech",
    "docs.pinecone.io",
    "platform.openai.com",
    "docs.mistral.ai",
    "docs.cohere.com",
    "vite.dev",
    "vitejs.dev",
    "react.dev",
    "nextjs.org",
    "vuejs.org",
  ];

  try {
    const host = new URL(url).hostname;
    return knownJsHosts.includes(host) || host.startsWith("docs.");
  } catch {
    return false;
  }
}

function isNavOnlyContent(content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 5) return true;

  const linkLines = lines.filter((l) =>
    /^\s*[\*\-]?\s*\[.+\]\(https?:\/\//.test(l),
  );
  const linkRatio = linkLines.length / lines.length;

  const paragraphs = lines.filter(
    (l) =>
      !/^[\*\-\[\#]/.test(l.trim()) && l.trim().length > 60,
  );

  return linkRatio > 0.6 && paragraphs.length < 3;
}
