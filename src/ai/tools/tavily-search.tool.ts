import { traceable } from "langsmith/traceable";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { isTracingEnabled } from "@/config/tracing";
import {
  buildWebSearchContext,
  type WebSearchResult,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "./web-search.types";

export type { WebSearchResult, WebSearchToolInput, WebSearchToolOutput };
export { buildWebSearchContext };

export function isTavilySearchAvailable(): boolean {
  return !!config.TAVILY_API_KEY;
}

async function tavilySearchInner(
  input: WebSearchToolInput,
): Promise<WebSearchToolOutput> {
  const { query, numResults = config.TAVILY_MAX_RESULTS } = input;

  if (!config.TAVILY_API_KEY) {
    throw new Error("Tavily Search API is not configured (TAVILY_API_KEY)");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: config.TAVILY_API_KEY,
      query: query.trim(),
      max_results: Math.min(Math.max(numResults, 1), 10),
      search_depth: "basic",
      include_answer: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily Search API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      score?: number;
    }>;
    error?: string;
  };

  if (data.error) {
    throw new Error(`Tavily Search API: ${data.error}`);
  }

  const results: WebSearchResult[] = (data.results ?? [])
    .filter((item) => item.url && item.title)
    .map((item) => {
      let displayLink: string | undefined;
      try {
        displayLink = new URL(item.url!).hostname;
      } catch {
        displayLink = undefined;
      }
      return {
        title: item.title!.trim(),
        url: item.url!.trim(),
        snippet: (item.content ?? "").trim(),
        displayLink,
        score: item.score,
      };
    });

  logger.debug(
    { query: query.slice(0, 80), resultCount: results.length, provider: "tavily" },
    "Web search tool: completed",
  );

  return { results, query, resultCount: results.length };
}

const tracedTavilySearch = traceable(tavilySearchInner, {
  name: "TavilySearchTool",
  run_type: "tool",
  tags: ["tool", "web-search", "tavily"],
});

/** Primary web search tool — uses [Tavily](https://www.tavily.com/) Search API. */
export async function tavilySearchTool(
  input: WebSearchToolInput,
): Promise<WebSearchToolOutput> {
  return isTracingEnabled() ? tracedTavilySearch(input) : tavilySearchInner(input);
}
