// src/services/query-expansion.service.ts
import { config } from "@config/env";
import { logger } from "@utils/logger";

const EXPANSION_PROMPT = `You help a document search system. Given the user's question, write exactly 3 short alternative phrasings that express the same information need using different words (synonyms, formal terms, related concepts like "authentication" vs "login", "token" vs "credentials"). Keep the same language as the question.

User question: {{QUESTION}}

Return ONLY a JSON array of exactly 3 strings. No markdown, no keys, no explanation.
Example: ["How does sign-in work?", "Authentication setup steps", "API token configuration"]`;

const cache = new Map<string, { variants: string[]; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;

export async function expandQueryVariants(question: string): Promise<string[]> {
  if (!config.GEMINI_API_KEY) return [];

  const key = question.trim().toLowerCase();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug({ question }, "Query expansion: cache hit");
    return cached.variants;
  }

  const model = config.GEMINI_MODEL || "gemini-2.0-flash-exp";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;
  const prompt = EXPANSION_PROMPT.replace("{{QUESTION}}", question.trim());

  try {
    logger.debug({ question }, "Query expansion: calling Gemini");

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }], role: "user" }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512,
          topP: 0.95,
          responseMimeType: "application/json",
          responseSchema: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 3,
          },
        },
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "Query expansion: Gemini request failed",
      );
      return [];
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message: string };
    };

    if (data.error) {
      logger.warn({ err: data.error.message }, "Query expansion: Gemini error");
      return [];
    }

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    if (!text) return [];

    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>([key]);

    const unique = (parsed as unknown[])
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length >= 2)
      .reduce<string[]>((acc, v) => {
        const k = v.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          acc.push(v);
        }
        return acc;
      }, [])
      .slice(0, 3);

    if (unique.length < 3) {
      logger.debug(
        `Query expansion: got ${unique.length} unique variants (wanted 3)`,
      );
    }

    cache.set(key, { variants: unique, expiresAt: Date.now() + TTL_MS });
    return unique;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "Query expansion failed — falling back to single-query retrieval",
    );
    return [];
  }
}