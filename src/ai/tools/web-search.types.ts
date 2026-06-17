export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  displayLink?: string;
  score?: number;
}

export interface WebSearchToolInput {
  query: string;
  numResults?: number;
}

export interface WebSearchToolOutput {
  results: WebSearchResult[];
  query: string;
  resultCount: number;
}

export function buildWebSearchContext(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return "No web search results were found for this query.";
  }

  return results
    .map(
      (r, i) =>
        `<web_source index="${i + 1}" url="${r.url}">\n` +
        `Title: ${r.title}\n` +
        `${r.snippet || "(No snippet available)"}\n` +
        `</web_source>`,
    )
    .join("\n\n");
}
