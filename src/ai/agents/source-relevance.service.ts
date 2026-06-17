import { config } from "@config/env";
import { logger } from "@utils/logger";
import {
  formatSourcesForPrompt,
  type SourceScopeContext,
} from "@/core/services/retrieval/source-scope.service";

export interface SourceRelevanceResult {
  isRelated: boolean;
  reason: string;
  method: "gemini" | "heuristic" | "no_sources";
}

const RELEVANCE_PROMPT = `You gate web search for a document Q&A system. Decide if the user's question is related to their indexed knowledge sources.

Indexed sources (scope: {{SCOPE}}):
{{SOURCES}}

User question: {{QUESTION}}

Rules:
- isRelated=true ONLY when the question is about topics, products, APIs, documentation, or domains these sources plausibly cover.
- isRelated=false when the question is general knowledge, unrelated hobbies, news, entertainment, or clearly outside these sources (e.g. sources are React docs but question is about cooking).
- Prefer isRelated=false when unsure — web search costs credits and should run only for source-related gaps.
- Questions like "summarize this", "what does X say about Y" where X matches a source topic are related.

Return ONLY JSON (no markdown):
{"isRelated": boolean, "reason": "one short sentence"}`;

function heuristicRelevance(
  question: string,
  ctx: SourceScopeContext,
): SourceRelevanceResult {
  if (ctx.sources.length === 0) {
    return {
      isRelated: false,
      reason: "No indexed sources in the current scope",
      method: "no_sources",
    };
  }

  const q = question.toLowerCase();
  const tokens = q.split(/\W+/).filter((t) => t.length > 3);

  for (const src of ctx.sources) {
    const haystack = `${src.title} ${src.url}`.toLowerCase();
    let hostname = "";
    try {
      hostname = new URL(src.url).hostname.replace(/^www\./, "");
    } catch {
      /* file:// or invalid */
    }

    if (hostname && q.includes(hostname.split(".")[0])) {
      return {
        isRelated: true,
        reason: `Question mentions source domain (${hostname})`,
        method: "heuristic",
      };
    }

    const titleWords = src.title
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 3);
    const overlap = tokens.filter((t) => titleWords.some((w) => w.includes(t) || t.includes(w)));
    if (overlap.length >= 2) {
      return {
        isRelated: true,
        reason: "Question overlaps with indexed source titles",
        method: "heuristic",
      };
    }

    if (tokens.some((t) => haystack.includes(t))) {
      return {
        isRelated: true,
        reason: "Question terms match an indexed source",
        method: "heuristic",
      };
    }
  }

  return {
    isRelated: false,
    reason: "Question does not appear related to indexed source topics",
    method: "heuristic",
  };
}

async function geminiRelevance(
  question: string,
  ctx: SourceScopeContext,
): Promise<SourceRelevanceResult> {
  const model = config.GEMINI_MODEL || "gemini-2.0-flash-exp";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;

  const prompt = RELEVANCE_PROMPT.replace("{{SCOPE}}", ctx.scopeLabel)
    .replace("{{SOURCES}}", formatSourcesForPrompt(ctx))
    .replace("{{QUESTION}}", question.trim());

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }], role: "user" }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 128,
        topP: 0.9,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(`Gemini relevance check failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!text) throw new Error("Gemini relevance check returned empty response");

  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as {
    isRelated?: unknown;
    reason?: unknown;
  };

  return {
    isRelated: parsed.isRelated === true,
    reason:
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : parsed.isRelated
          ? "Question appears related to indexed sources"
          : "Question appears unrelated to indexed sources",
    method: "gemini",
  };
}

/**
 * Returns whether a question is related to the user's indexed sources.
 * Unrelated questions skip Tavily to preserve API credits.
 */
export async function isQuestionRelatedToSources(
  question: string,
  ctx: SourceScopeContext,
): Promise<SourceRelevanceResult> {
  if (ctx.sources.length === 0) {
    return {
      isRelated: false,
      reason: "No indexed sources in the current scope",
      method: "no_sources",
    };
  }

  if (config.GEMINI_API_KEY) {
    try {
      const result = await geminiRelevance(question, ctx);
      logger.debug(
        { isRelated: result.isRelated, method: result.method, reason: result.reason },
        "Source relevance check",
      );
      return result;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "Gemini relevance check failed — using heuristic",
      );
    }
  }

  return heuristicRelevance(question, ctx);
}

export function buildUnrelatedSourceAnswer(scopeLabel: string): string {
  return (
    `I couldn't find this information in your indexed documents (${scopeLabel}), ` +
    "and this question doesn't appear related to your uploaded sources, so I skipped web search. " +
    "Try rephrasing your question or selecting a relevant source scope."
  );
}
