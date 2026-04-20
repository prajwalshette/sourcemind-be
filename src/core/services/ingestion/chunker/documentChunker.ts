// src/services/chunker/documentChunker.ts
// Central type definitions for the file-chunker pipeline.
// All chunker sub-services import from here — do NOT redeclare globally.

export interface ParsedElement {
  type: 'heading' | 'paragraph' | 'table' | 'list' | 'code' | 'skip';
  level?: number;       // heading level 1-3
  text: string;         // serialized text for embedding
  rawContent?: string;  // original for storage
  section?: string;     // nearest heading above this element
}

export interface ChunkResult {
  text: string;         // child → goes to Qdrant
  parentText: string;   // parent section → goes to Gemini
  parentId: string;
  chunkIndex: number;
  section?: string;
  tokenCount: number;
}