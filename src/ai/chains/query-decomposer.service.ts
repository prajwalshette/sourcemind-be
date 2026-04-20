import { config } from "@config/env";
import { logger } from "@utils/logger";

export interface DecomposedQuery {
  subQuestions: string[];
  isCompound: boolean;
}

const DECOMPOSE_PROMPT = `You help a document search system. Analyse the user's question and decide if it contains multiple distinct information needs.

Rules:
- If the question has ONE clear focus, return it as-is in a single-element array.
- If the question has TWO OR MORE independent sub-topics, split it. Each sub-question must be independently answerable and self-contained.
- Max 4 sub-questions. Do not over-split — "how do I set up auth with the free plan?" is ONE question (auth is the subject, free plan is a constraint).
- Keep the same language as the question.

User question: {{QUESTION}}

Return ONLY a JSON object with exactly this shape (no markdown, no explanation):
{"isCompound": boolean, "subQuestions": ["...","..."]}

Single-focus example: {"isCompound": false, "subQuestions": ["How does authentication work?"]}
Multi-focus example:  {"isCompound": true,  "subQuestions": ["What are the pricing tiers?", "How does authentication work?"]}`;

export async function decomposeQuery(
  question: string
): Promise<DecomposedQuery> {
  const fallback: DecomposedQuery = {
    subQuestions: [question],
    isCompound: false,
  };

  if (!config.GEMINI_API_KEY) return fallback;

  const model = config.GEMINI_MODEL || "gemini-2.0-flash-exp";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;
  const prompt = DECOMPOSE_PROMPT.replace("{{QUESTION}}", question.trim());

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }], role: "user" }],
        generationConfig: {
          temperature: 0.1, // Low temp — this is a classification task
          maxOutputTokens: 256,
          topP: 0.9,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, "Decomposer: Gemini request failed");
      return fallback;
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message: string };
    };

    if (data.error) {
      logger.warn({ err: data.error.message }, "Decomposer: Gemini error");
      return fallback;
    }

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    if (!text) return fallback;

    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { subQuestions: unknown }).subQuestions)
    ) {
      return fallback;
    }

    const { subQuestions, isCompound } = parsed as {
      subQuestions: unknown[];
      isCompound: unknown;
    };

    const clean_questions = subQuestions
      .filter((q): q is string => typeof q === "string" && q.trim().length > 4)
      .map((q) => q.trim())
      .slice(0, 4);

    if (clean_questions.length === 0) return fallback;

    return {
      subQuestions: clean_questions,
      isCompound: typeof isCompound === "boolean" ? isCompound : clean_questions.length > 1,
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "Decomposer failed — treating as single question"
    );
    return fallback;
  }
}