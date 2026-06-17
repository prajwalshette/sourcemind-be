export {
  tavilySearchTool,
  buildWebSearchContext,
  isTavilySearchAvailable,
} from "./tavily-search.tool";
export type {
  WebSearchResult,
  WebSearchToolInput,
  WebSearchToolOutput,
} from "./web-search.types";
export { RAG_TOOL_DECLARATIONS } from "./tool-definitions";
export type { RagToolName } from "./tool-definitions";

import { retrieve } from "@/core/services/retrieval/retriever.service";
import { RetrievedChunk } from "@/core/types/retrieval.interface";
import type { RetrievalOptions } from "@/core/types/retrieval.interface";

/** Tool: search_indexed_documents — wraps hybrid retrieval for tool-calling workflows. */
export async function searchIndexedDocumentsTool(
  query: string,
  options: RetrievalOptions & { topK?: number } = {},
): Promise<{ chunks: RetrievedChunk[]; topScore: number }> {
  const chunks = await retrieve(query, options);
  return {
    chunks,
    topScore: chunks[0]?.score ?? 0,
  };
}
