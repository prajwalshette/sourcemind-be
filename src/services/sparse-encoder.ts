// src/services/sparse-encoder.ts
// BM25-style sparse vector encoder for hybrid retrieval (keyword matching).
// Exported for use in qdrant.service and ingestion.service.

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "can",
  "could",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "if",
  "not",
  "no",
]);

export function textToSparseVector(
  text: string,
): { indices: number[]; values: number[] } {
  const VOCAB_SIZE = 30_000;
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (tokens.length === 0) return { indices: [0], values: [0.001] };

  const tf = new Map<number, number>();
  for (const token of tokens) {
    const idx = tokenToIndex(token, VOCAB_SIZE);
    tf.set(idx, (tf.get(idx) || 0) + 1);
  }
  const maxTf = Math.max(...tf.values());
  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, count] of tf.entries()) {
    indices.push(idx);
    values.push(count / maxTf);
  }
  return { indices, values };
}

function tokenToIndex(token: string, vocabSize: number): number {
  let hash = 5381;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) + hash) ^ token.charCodeAt(i);
    hash = hash >>> 0;
  }
  return (hash % vocabSize) + 1;
}
