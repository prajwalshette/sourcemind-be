export interface RetrievalOptions {
  topK?: number;
  mmrLambda?: number;
  scoreThreshold?: number;
  documentId?: string;
  /** Search across all pages of a site crawl (site_key filter in Qdrant) */
  siteKey?: string;
  /** v3: use hybrid (dense + BM25 + RRF). Default true when available. */
  useHybrid?: boolean;
  domain?: string;
  sourceType?: string;
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
}

export interface RetrievedChunk {
  /** Qdrant point id — used to merge/dedupe multi-query retrieval */
  pointId?: string;
  text: string;
  score: number;
  rerankScore?: number;
  metadata: Record<string, unknown>;
  sourceUrl: string;
  section: string | null;
  hypotheticalQuestions?: string[];
  matchedQuestion?: string;
}
