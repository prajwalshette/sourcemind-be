/**
 * Gemini-compatible function declarations for RAG fallback tool calling.
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */
export const RAG_TOOL_DECLARATIONS = [
  {
    name: "search_indexed_documents",
    description:
      "Retrieve the most relevant chunks from the user's indexed knowledge base. Always call this first.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: {
          type: "STRING",
          description: "The user's question or search query",
        },
        top_k: {
          type: "INTEGER",
          description: "Maximum number of document chunks to retrieve (default 8)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web using Tavily Search API. Call ONLY when indexed documents are insufficient AND the question is related to the user's indexed sources.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: {
          type: "STRING",
          description: "The search query for the web",
        },
        num_results: {
          type: "INTEGER",
          description: "Number of web results to fetch (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
] as const;

export type RagToolName = "search_indexed_documents" | "web_search";
