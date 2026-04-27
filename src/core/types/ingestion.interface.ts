export interface IngestJobData {
  url: string;
  documentId: string;
  uploadedBy: string;
  webhookUrl?: string;
  crawlAllPages?: boolean;
  maxPages?: number;
}

/**
 * Job payload for file-based ingestion.
 * Buffer is stored as base64 because Redis cannot hold raw Buffers.
 */
export interface FileIngestJobData {
  documentId: string;
  bufferBase64: string;  // Buffer.from(file.buffer).toString('base64')
  mimeType: string;
  fileName: string;
  uploadedBy?: string;
}



export interface IngestResult {
  documentId: string;
  chunkCount: number;
  tokenCount: number;
  /** Total hypothetical questions generated across chunks (v3). */
  totalQuestions?: number;
  status: string;
  title: string;
}

export interface LoadedDocument {
  url: string;
  title: string;
  content: string;
  contentType: "markdown" | "text";
  wordCount: number;
  loader?: "crawl4ai" | "cheerio" | "firecrawl" | "playwright";
  pagesCrawled?: number;
  metadata: Record<string, string>;
}

export interface Chunk {
  text: string;
  /** Parent section text (for LLM context upgrade after retrieval). */
  parentText?: string;
  /** Links children to their parent section. */
  parentId?: string;
  textHash: string;
  tokenCount: number;
  chunkIndex: number;
  section: string | null;
  /** Hypothetical questions generated per chunk for better retrieval (v3). */
  hypotheticalQuestions?: string[];
  metadata: Record<string, string | number | null>;
}
