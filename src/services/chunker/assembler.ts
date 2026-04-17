// src/services/chunker/assembler.ts
import { createHash } from 'crypto';
import { ParsedElement, ChunkResult } from './documentChunker';

const CHILD_TOKENS  = 128;
const PARENT_TOKENS = 512;
const OVERLAP       = 20;

export function assembleChunks(
  elements: ParsedElement[],
  documentId: string
): ChunkResult[] {
  const results: ChunkResult[] = [];
  let currentSection = 'General';
  let parentBuffer: string[] = [];
  let parentId = newId();

  const flushParent = () => {
    if (parentBuffer.length === 0) return;
    const parentText = parentBuffer.join('\n');
    const children = toChildChunks(parentText, CHILD_TOKENS, OVERLAP);
    children.forEach((text, i) => {
      results.push({
        text,               // small child → Qdrant
        parentText,         // full section → Gemini
        parentId,
        chunkIndex: i,
        section: currentSection,
        tokenCount: est(text),
      });
    });
    parentBuffer = [];
    parentId = newId();
  };

  for (const el of elements) {
    if (el.type === 'heading') {
      flushParent();                    // close previous section
      currentSection = el.text;
    } else if (el.type === 'skip') {
      continue;
    } else if (el.type === 'code') {
      // Code blocks: never split — emit as single chunk, child = parent
      flushParent();
      const pid = newId();
      results.push({
        text: el.text, parentText: el.text,
        parentId: pid, chunkIndex: 0,
        section: currentSection,
        tokenCount: est(el.text),
      });
    } else if (el.type === 'table') {
      // Table rows: each serialized row is already one chunk
      flushParent();
      el.text.split('\n').filter(Boolean).forEach((row, i) => {
        const pid = newId();
        results.push({
          text: row, parentText: row,
          parentId: pid, chunkIndex: i,
          section: currentSection,
          tokenCount: est(row),
        });
      });
    } else {
      // paragraph / list: accumulate into parent buffer
      parentBuffer.push(el.text);
      if (est(parentBuffer.join('\n')) >= PARENT_TOKENS) flushParent();
    }
  }

  flushParent(); // flush last section
  return results;
}

function toChildChunks(text: string, size: number, overlap: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + size).join(' '));
    i += size - overlap;
  }
  return chunks;
}

const est = (t: string) => Math.ceil(t.length / 4);
const newId = () => createHash('sha256').update(Math.random().toString()).digest('hex').slice(0, 16);