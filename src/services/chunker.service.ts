// src/services/chunker.service.ts
// v3: Structure-aware chunking + Hypothetical Question Generation (batch Gemini).
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { hashText } from "@utils/sanitize";

import { Chunk } from "@interfaces/ingestion.interface";

// Approx: 1 token ≈ 4 chars for English
const TOKEN_TO_CHAR = 4;
const CHUNK_SIZE_CHARS = config.CHUNK_SIZE * TOKEN_TO_CHAR; // 512 * 4 = 2048
const CHUNK_OVERLAP_CHARS = config.CHUNK_OVERLAP * TOKEN_TO_CHAR; // 50 * 4 = 200

// Parent-child constants (big quality gain)
// Parent: full H2 section (for LLM context)
// Child: smaller chunk for precise retrieval
const PARENT_SIZE_CHARS = 800 * TOKEN_TO_CHAR; // ~800 tokens
const CHILD_SIZE_CHARS = 200 * TOKEN_TO_CHAR; // ~200 tokens
const CHILD_OVERLAP_CHARS = 30 * TOKEN_TO_CHAR; // ~30 tokens (~15%)

type RawChunk = {
  text: string;
  parentText?: string;
  parentId?: string;
};

export async function chunkDocument(
  content: string,
  contentType: "markdown" | "text",
  metadata: Record<string, string>,
): Promise<Chunk[]> {
  let rawChunks: RawChunk[];

  if (contentType === "markdown") {
    rawChunks = await markdownParentChildChunk(content);
  } else {
    const texts = await recursiveChunk(content);
    rawChunks = texts.map((text) => ({ text }));
  }

  // Deduplicate + filter
  const seen = new Set<string>();
  const chunks: Chunk[] = [];

  for (const [i, raw] of rawChunks.entries()) {
    const trimmed = raw.text.trim();
    if (!trimmed) continue;

    const tokenCount = estimateTokens(trimmed);
    if (tokenCount < 20) continue; // too small (website chunks can be shorter)

    const textHash = hashText(trimmed);
    // With parent-child, avoid deduping the same child text across different parents.
    const dedupKey = raw.parentId ? `${raw.parentId}:${textHash}` : textHash;
    if (seen.has(dedupKey)) continue; // duplicate
    seen.add(dedupKey);

    chunks.push({
      text: trimmed,
      parentText: raw.parentText,
      parentId: raw.parentId,
      textHash,
      tokenCount,
      chunkIndex: chunks.length,
      section: extractSection(trimmed),
      hypotheticalQuestions: [],
      metadata: { ...metadata, chunkIndex: i },
    });
  }

  logger.debug(
    `Chunked into ${chunks.length} chunks (contentType: ${contentType})`,
  );

  // v3: Optional — 3–5 hypothetical questions per chunk (batch Gemini). Off by default to save quota.
  if (
    config.GENERATE_HYPOTHETICAL_QUESTIONS &&
    config.GEMINI_API_KEY &&
    chunks.length > 0
  ) {
    try {
      const questions = await generateHypotheticalQuestions(chunks);
      for (let i = 0; i < chunks.length; i++) {
        chunks[i].hypotheticalQuestions = questions[i] ?? [];
      }
      const total = chunks.reduce(
        (s, c) => s + (c.hypotheticalQuestions?.length ?? 0),
        0,
      );
      logger.info(
        `Generated ${total} hypothetical questions for ${chunks.length} chunks`,
      );
    } catch (err) {
      logger.warn(
        `Hypothetical question generation failed — continuing without: ${(err as Error).message}`,
      );
    }
  }

  return chunks;
}

// ─── Parent-Child Builder ───────────────────────────────────────────────────
async function markdownParentChildChunk(text: string): Promise<RawChunk[]> {
  const { parentSections, prefaceText } = splitAtH2Sections(text);

  // If there are no H2 sections, fall back to your regular markdown chunking.
  if (parentSections.length === 0) {
    const chunks = await markdownAwareChunk(text);
    return chunks.map((c) => ({ text: c }));
  }

  const raw: RawChunk[] = [];

  // Chunk anything before the first H2 without parent context.
  if (prefaceText.trim().length > 0) {
    const preChunks = await markdownAwareChunk(prefaceText);
    raw.push(...preChunks.map((c) => ({ text: c })));
  }

  for (const parentSection of parentSections) {
    const parentFull = parentSection.trim();
    if (!parentFull) continue;

    const parentText = parentFull.length > PARENT_SIZE_CHARS
      ? parentFull.slice(0, PARENT_SIZE_CHARS).trim()
      : parentFull;

    const parentId = hashText(parentText);
    const childTexts = await splitH2SectionIntoChildren(parentFull);

    for (const childText of childTexts) {
      raw.push({ text: childText, parentText, parentId });
    }
  }

  return raw;
}

function splitAtH2Sections(text: string): {
  parentSections: string[];
  prefaceText: string;
} {
  const lines = text.split("\n");
  const parentSections: string[] = [];
  let current: string[] = [];
  let started = false;
  const prefaceLines: string[] = [];

  for (const line of lines) {
    if (/^##\s+.+$/.test(line.trim())) {
      if (!started) {
        started = true;
        current = [line];
      } else {
        parentSections.push(current.join("\n"));
        current = [line];
      }
    } else {
      if (started) current.push(line);
      else prefaceLines.push(line);
    }
  }

  if (started && current.length > 0) parentSections.push(current.join("\n"));
  return { parentSections, prefaceText: prefaceLines.join("\n") };
}

async function splitH2SectionIntoChildren(parentSectionText: string) {
  const subsections = splitAtMarkdownHeadings(parentSectionText);
  const childChunks: string[] = [];

  for (const subsection of subsections) {
    const sectionText = subsection.trim();
    if (!sectionText) continue;

    if (isFaqSection(sectionText)) {
      childChunks.push(sectionText);
      continue;
    }

    if (containsTable(sectionText)) {
      childChunks.push(...splitPreservingTables(sectionText));
      continue;
    }

    if (containsCodeBlock(sectionText)) {
      childChunks.push(
        ...splitAroundCodeBlocksWithSizes(
          sectionText,
          CHILD_SIZE_CHARS,
          CHILD_OVERLAP_CHARS,
        ),
      );
      continue;
    }

    if (sectionText.length <= CHILD_SIZE_CHARS) {
      childChunks.push(sectionText);
    } else {
      const subChunks = await recursiveChunkWithSizes(
        sectionText,
        CHILD_SIZE_CHARS,
        CHILD_OVERLAP_CHARS,
      );
      childChunks.push(...subChunks);
    }
  }

  return childChunks.filter((c) => c.trim().length > 0);
}

// RecursiveCharacterTextSplitter but with explicit sizes for parent-child children.
async function recursiveChunkWithSizes(
  text: string,
  chunkSizeChars: number,
  chunkOverlapChars: number,
): Promise<string[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: chunkSizeChars,
    chunkOverlap: chunkOverlapChars,
    separators: ["\n\n\n", "\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " ", ""],
  });
  const docs = await splitter.createDocuments([text]);
  return docs.map((d) => d.pageContent);
}

function splitAroundCodeBlocksWithSizes(
  text: string,
  chunkSizeChars: number,
  chunkOverlapChars: number,
): string[] {
  const codeBlockRegex = /(```[\s\S]*?```)/g;
  const parts = text.split(codeBlockRegex);
  const chunks: string[] = [];
  let buffer = "";

  for (const part of parts) {
    const isCode = /^```/.test(part);

    if (isCode) {
      // Never split code blocks — keep as own chunk.
      if (buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = "";
      }
      chunks.push(part);
    } else {
      buffer += part;
      if (buffer.length > chunkSizeChars) {
        chunks.push(buffer.trim());
        buffer = buffer.slice(-chunkOverlapChars);
      }
    }
  }

  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

// ─── Hypothetical Question Generation (batch Gemini) ─────────────────────────
const BATCH_SIZE = 20;

async function generateHypotheticalQuestions(
  chunks: Chunk[],
): Promise<string[][]> {
  const allQuestions: string[][] = new Array(chunks.length).fill(null).map(() => []);

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const batchStart = i;

    const prompt = `You are generating hypothetical questions for a RAG system.
For each chunk of text below, generate 3-5 questions that this chunk would directly answer.
Make them diverse, natural, and specific (not generic).

Chunks:
${batch.map((c, idx) => `CHUNK_${idx}:\n"""${c.text.slice(0, 600)}"""`).join("\n\n")}

Return ONLY a JSON object where keys are "CHUNK_0", "CHUNK_1", etc. and values are arrays of question strings.
Example: { "CHUNK_0": ["What is the refund policy?"], "CHUNK_1": ["What payment methods are accepted?"] }
No explanation, no markdown, just the JSON object.`;

    const model = config.GEMINI_MODEL || "gemini-2.0-flash-exp";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }], role: "user" }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        logger.warn("Gemini rate limited during question generation — skipping remaining batches");
        break;
      }
      throw new Error(`Gemini error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean) as Record<string, string[]>;

    for (let j = 0; j < batch.length; j++) {
      const questions = result[`CHUNK_${j}`];
      if (Array.isArray(questions)) {
        allQuestions[batchStart + j] = questions
          .filter((q) => typeof q === "string" && q.length > 10)
          .slice(0, 5);
      }
    }

    if (i + BATCH_SIZE < chunks.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return allQuestions;
}

// ─── STRATEGY 1: Recursive Character Chunking ────────────────────────────────
async function recursiveChunk(text: string): Promise<string[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE_CHARS,
    chunkOverlap: CHUNK_OVERLAP_CHARS,
    separators: ["\n\n\n", "\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " ", ""],
  });
  const docs = await splitter.createDocuments([text]);
  return docs.map((d) => d.pageContent);
}

// ─── STRATEGY 2: Markdown-Aware Chunking (table-aware) ───────────────────────
async function markdownAwareChunk(text: string): Promise<string[]> {
  const sections = splitAtMarkdownHeadings(text);
  const allChunks: string[] = [];

  for (const section of sections) {
    // FAQ: if heading is a question + answer is short, keep Q+A atomic.
    // This prevents retrieval from returning only the question or only the answer.
    if (isFaqSection(section)) {
      allChunks.push(section.trim());
      continue;
    }

    if (section.length <= CHUNK_SIZE_CHARS) {
      if (section.trim().length > 0) allChunks.push(section);
    } else if (containsCodeBlock(section)) {
      allChunks.push(...splitAroundCodeBlocks(section));
    } else if (containsTable(section)) {
      allChunks.push(...splitPreservingTables(section));
    } else {
      const subChunks = await recursiveChunk(section);
      allChunks.push(...subChunks);
    }
  }

  return allChunks;
}

function containsTable(t: string): boolean {
  return /^\|.+\|$/m.test(t);
}

// FAQ detection signal: the section starts with a question heading and the section is short.
// We expect the markdown-aware splitter to already split by H1/H2/H3 headings.
function isFaqSection(section: string): boolean {
  const lines = section
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return false;

  const heading = lines[0];
  const isQuestionHeading = /^#{1,3}\s.+\?\s*$/.test(heading);
  if (!isQuestionHeading) return false;

  const wordCount = section.trim().split(/\s+/).filter(Boolean).length;
  return wordCount < 150; // "short answer" heuristic
}

function splitPreservingTables(text: string): string[] {
  // Website tables should keep column headers in EVERY chunk.
  // We chunk table BLOCKS by rows, repeating:
  //   headerRow (+ separatorRow if present) + dataRowBatch

  const lines = text.split("\n");
  const resultChunks: string[] = [];

  let buffer: string[] = [];
  const flushBuffer = () => {
    const s = buffer.join("\n").trim();
    if (s) resultChunks.push(s);
    buffer = [];
  };

  const isTableRowLine = (line: string) => /^\|/.test(line.trim());

  const ROWS_PER_CHUNK = 50;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!isTableRowLine(line)) {
      buffer.push(line);
      i++;
      continue;
    }

    // We hit a table block. Flush non-table content before it.
    flushBuffer();

    const tableBlockLines: string[] = [];
    while (i < lines.length && isTableRowLine(lines[i])) {
      tableBlockLines.push(lines[i]);
      i++;
    }

    if (tableBlockLines.length === 0) continue;

    const headerRow = tableBlockLines[0];
    const separatorCandidate = tableBlockLines[1];

    const hasSeparator =
      !!separatorCandidate &&
      /^[\|\:\-\s]+$/.test(separatorCandidate.trim()); // allow ":" alignment

    const separatorRow = hasSeparator ? separatorCandidate : null;
    const dataRows = separatorRow
      ? tableBlockLines.slice(2)
      : tableBlockLines.slice(1);

    for (let r = 0; r < dataRows.length; r += ROWS_PER_CHUNK) {
      const batch = dataRows.slice(r, r + ROWS_PER_CHUNK);
      const headerParts = separatorRow
        ? [headerRow, separatorRow]
        : [headerRow];

      const chunk = [...headerParts, ...batch].join("\n").trim();
      if (chunk) resultChunks.push(chunk);
    }
  }

  flushBuffer();
  return resultChunks.filter((c) => c.trim().length > 0);
}

// Split markdown at H1/H2/H3 boundaries
function splitAtMarkdownHeadings(text: string): string[] {
  const headingRegex = /^(#{1,3}\s.+)$/m;
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (headingRegex.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections.filter((s) => s.trim().length > 0);
}

// Split section but never split inside code blocks
function splitAroundCodeBlocks(text: string): string[] {
  const codeBlockRegex = /(```[\s\S]*?```)/g;
  const parts = text.split(codeBlockRegex);
  const chunks: string[] = [];
  let buffer = "";

  for (const part of parts) {
    const isCode = /^```/.test(part);

    if (isCode) {
      // Never split code blocks — keep as own chunk if too large
      if (buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = "";
      }
      chunks.push(part); // code block is atomic
    } else {
      buffer += part;
      if (buffer.length > CHUNK_SIZE_CHARS) {
        chunks.push(buffer.trim());
        buffer = buffer.slice(-CHUNK_OVERLAP_CHARS); // keep overlap
      }
    }
  }

  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

function containsCodeBlock(text: string): boolean {
  return /```[\s\S]*?```/.test(text);
}

// Extract section heading from chunk text
function extractSection(text: string): string | null {
  const match = text.match(/^#{1,6}\s+(.+)$/m);
  return match ? match[1].trim().slice(0, 200) : null;
}

// Approximate token count (1 token ≈ 4 chars)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_TO_CHAR);
}
