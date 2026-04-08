export interface SparseVector {
  indices: number[];
  values: number[];
}

export interface QdrantPoint {
  id: string;
  /** Dense vector (required). When sparseVector is set, stored under named vector "dense". */
  vector: number[];
  /** Optional sparse BM25 vector for hybrid search (v3). */
  sparseVector?: SparseVector;
  payload: {
    text: string;
    document_id: string;
    chunk_index: number;
    token_count: number;
    section: string | null;
    url: string;
    title: string;
    domain: string;
    embedding_model: string;
    created_at: string;
    /** siteKey groups all child pages of a site crawl, e.g. "https://developers.facebook.com/docs" */
    site_key?: string;
    /** v3: hypothetical questions for question-boost retrieval */
    hypothetical_questions?: string[];
    has_questions?: boolean;
    /** v3: rich metadata filters */
    source_type?: string;
    tags?: string[];
    loader?: string;
    [key: string]: unknown;
  };
}

export interface SearchFilter {
  documentId?: string;
  /** Filter to all pages under a site crawl — matches site_key in Qdrant payload */
  siteKey?: string;
  domain?: string;
  sourceType?: string;
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
  hasQuestions?: boolean;
}

export interface SearchResult {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}
