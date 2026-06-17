export type AnswerSourceType = "document" | "web";

export interface QueryOptions {
  documentId?: string;
  sessionId?: string;
  /** Authenticated user scoping (multi-tenant isolation). */
  userId: string;
  /** When false, skip web search fallback even if configured. Default: follow RAG_FALLBACK_ENABLED. */
  skipWebFallback?: boolean;
  /** Search across all pages of a site crawl (e.g. "https://developers.facebook.com/docs") */
  siteKey?: string;
  topK?: number;
  useCache?: boolean;
  skipIntelligence?: boolean;
  /** v3: use hybrid retrieval (dense + BM25 + RRF). Default true. */
  useHybrid?: boolean;
  /** v3: skip hallucination audit. Default false. */
  skipAudit?: boolean;
  /** When false (default) and GEMINI_API_KEY is set, rewrite the question into 3 paraphrases, retrieve for each, merge and dedupe. */
  skipQueryExpansion?: boolean;
  domain?: string;
  sourceType?: string;
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
}

export interface QueryResult {
  answer: string;
  sources: Array<{
    index: number;
    url: string;
    section: string | null;
    excerpt: string;
    score: number;
    relevanceScore?: number;
    matchedQuestion?: string;
  }>;
  model: string;
  confidence: number;
  fromCache: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  intelligence?: {
    used: boolean;
    chunksBeforeFilter: number;
    chunksAfterFilter: number;
    droppedChunks: number;
    compressionRatio: number;
    processingMs: number;
  };
  /** v3: hallucination audit result. */
  audit?: {
    passed: boolean;
    groundednessScore: number;
    completenessScore: number;
    confidence: "high" | "medium" | "low" | "skip";
    hallucinations: string[];
    auditorUsed: boolean;
  };
  langsmithRunUrl?: string;
  /** Set when multi-step retrieval ran (decompose + expansion). */
  retrieval?: {
    subQuestions: string[];
    isCompound: boolean;
  };
  /** Whether the answer was grounded in indexed documents or web search. */
  sourceType?: AnswerSourceType;
  /** True when web search fallback was used instead of (or due to lack of) documents. */
  fallbackUsed?: boolean;
  /** User-facing notice when web fallback was triggered. */
  fallbackNotification?: string | null;
}

export interface GenerationResult {
  answer: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export type QueryStreamStage =
  | "understanding"
  | "searching"
  | "web_searching"
  | "thinking"
  | "writing"
  | "done";

export const QUERY_STREAM_LABELS: Record<QueryStreamStage, string> = {
  understanding: "🔍 Understanding your question...",
  searching: "📚 Searching indexed documents...",
  web_searching: "🌐 Searching trusted web sources...",
  thinking: "💡 Thinking...",
  writing: "✍️ Writing response...",
  done: "✓ Done",
};

export interface QueryStreamStatus {
  stage: QueryStreamStage;
  label: string;
  detail?: string;
}

export function queryStreamStatus(stage: QueryStreamStage): QueryStreamStatus {
  return { stage, label: QUERY_STREAM_LABELS[stage] };
}
