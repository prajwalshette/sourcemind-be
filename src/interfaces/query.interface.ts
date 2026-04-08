export interface QueryOptions {
  documentId?: string;
  sessionId?: string;
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
}

export interface GenerationResult {
  answer: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}
