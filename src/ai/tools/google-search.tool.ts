import { traceable } from "langsmith/traceable";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { isTracingEnabled } from "@/config/tracing";
import type {
  WebSearchResult,
  WebSearchToolInput,
  WebSearchToolOutput,
} from "./web-search.types";
import { buildWebSearchContext } from "./web-search.types";

export type { WebSearchResult, WebSearchToolInput, WebSearchToolOutput };
export { buildWebSearchContext };

export function isWebSearchAvailable(): boolean {
  return !!(config.GOOGLE_SEARCH_API_KEY && config.GOOGLE_CSE_ID);
}

async function googleSearchInner(
  input: WebSearchToolInput,
): Promise<WebSearchToolOutput> {
  const { query, numResults = 5 } = input;

  if (!config.GOOGLE_SEARCH_API_KEY || !config.GOOGLE_CSE_ID) {
    throw new Error("Google Search API is not configured (GOOGLE_SEARCH_API_KEY / GOOGLE_CSE_ID)");
  }

  const params = new URLSearchParams({
    key: config.GOOGLE_SEARCH_API_KEY,
    cx: config.GOOGLE_CSE_ID,
    q: query.trim(),
    num: String(Math.min(Math.max(numResults, 1), 10)),
  });

  const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Search API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    items?: Array<{
      title?: string;
      link?: string;
      snippet?: string;
      displayLink?: string;
    }>;
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(`Google Search API: ${data.error.message}`);
  }

  const results: WebSearchResult[] = (data.items ?? [])
    .filter((item) => item.link && item.title)
    .map((item) => ({
      title: item.title!.trim(),
      url: item.link!.trim(),
      snippet: (item.snippet ?? "").trim(),
      displayLink: item.displayLink,
    }));

  logger.debug(
    { query: query.slice(0, 80), resultCount: results.length },
    "Web search tool: completed",
  );

  return { results, query, resultCount: results.length };
}

const tracedGoogleSearch = traceable(googleSearchInner, {
  name: "WebSearchTool",
  run_type: "tool",
  tags: ["tool", "web-search", "google"],
});

export async function webSearchTool(
  input: WebSearchToolInput,
): Promise<WebSearchToolOutput> {
  return isTracingEnabled() ? tracedGoogleSearch(input) : googleSearchInner(input);
}
