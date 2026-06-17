export const RAG_FALLBACK_POLICY = {
  enabled: true,
  description:
    "Use indexed documents as the primary source of truth. If no relevant information is found, automatically perform a web search using Tavily Search API.",
  confidenceThreshold: 0.7,
  workflow: [
    {
      step: 1,
      action: "Search indexed documents",
      instruction: "Retrieve the most relevant chunks from the knowledge base.",
    },
    {
      step: 2,
      action: "Evaluate results",
      instruction:
        "If confidence score is below 0.7 or no relevant documents are found, consider web search.",
    },
    {
      step: 3,
      action: "Check source relevance",
      instruction:
        "Only trigger web search if the question is related to the user's indexed sources. Skip web search for unrelated questions to save API credits.",
    },
    {
      step: 4,
      action: "Tavily Search Fallback",
      instruction:
        "Search the web using Tavily Search API and collect authoritative sources.",
    },
    {
      step: 5,
      action: "Generate response",
      instruction:
        "Create an answer based on web search results and include source links.",
    },
  ],
  userNotification: {
    show: true,
    message:
      "I couldn't find this information in your uploaded documents, so I searched trusted web sources and generated the answer below.",
  },
  responseFormat: {
    sourceType: "document | web" as const,
    includeSources: true,
    showConfidence: true,
  },
  rules: [
    "Always prioritize indexed documents over web results.",
    "Never mix document facts and web facts without clearly identifying the source.",
    "If information comes from web search, explicitly tell the user.",
    "Include source URLs for web-based answers.",
    "If neither documents nor web search contain reliable information, state that the answer could not be verified.",
    "Do not call web search when the question is unrelated to the user's indexed sources.",
  ],
} as const;

export type AnswerSourceType = "document" | "web";
