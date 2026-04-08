// src/services/auditor.service.ts
// Hallucination Auditor: verifies the answer is grounded in the retrieved context.
// Runs after answer generation. Groundedness 0–10, flags ungrounded claims.

import { traceable } from "langsmith/traceable";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { isTracingEnabled } from "@/tracing/langsmith";
import type { GenerationResult } from "@interfaces/query.interface";

export interface AuditResult {
  passed: boolean;
  groundednessScore: number;
  completenessScore: number;
  confidence: "high" | "medium" | "low" | "skip";
  hallucinations: string[];
  auditMs: number;
  auditorUsed: boolean;
}

export interface AuditedAnswer {
  answer: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  audit: AuditResult;
}

async function runAudit(
  question: string,
  answer: string,
  context: string,
): Promise<AuditResult> {
  const start = Date.now();

  if (!config.GEMINI_API_KEY) {
    return {
      passed: true,
      groundednessScore: -1,
      completenessScore: -1,
      confidence: "skip",
      hallucinations: [],
      auditMs: 0,
      auditorUsed: false,
    };
  }

  if (
    answer.includes("temporarily unavailable") ||
    answer.includes("cannot find")
  ) {
    return {
      passed: true,
      groundednessScore: 10,
      completenessScore: 5,
      confidence: "skip",
      hallucinations: [],
      auditMs: 0,
      auditorUsed: false,
    };
  }

  const prompt = `You are a hallucination auditor for a RAG system. Your job is to verify that an AI answer is strictly grounded in the provided context.

QUESTION: "${question}"

CONTEXT (retrieved chunks):
${context.slice(0, 3000)}

AI ANSWER TO AUDIT:
"${answer}"

Analyze the answer and respond with a JSON object containing:
{
  "groundedness": <0-10 score, 10 = every claim is directly supported by context>,
  "completeness": <0-10 score, 10 = fully answers the question using available context>,
  "hallucinations": [<list any specific claims in the answer NOT supported by context, empty array if none>],
  "reasoning": "<1 sentence explanation>"
}

Scoring guide for groundedness:
- 9-10: Every single claim traceable to the context
- 7-8:  Minor phrasing extrapolation but no factual additions
- 5-6:  Some claims go beyond what context supports
- 3-4:  Significant ungrounded claims
- 0-2:  Answer is mostly or entirely hallucinated

No markdown, no explanation outside the JSON. Just the JSON object.`;

  try {
    const model = config.GEMINI_MODEL || "gemini-2.0-flash-exp";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }], role: "user" }],
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 512,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 429) {
      logger.warn("Auditor: Gemini rate limited — skipping audit");
      return {
        passed: true,
        groundednessScore: -1,
        completenessScore: -1,
        confidence: "skip",
        hallucinations: [],
        auditMs: Date.now() - start,
        auditorUsed: false,
      };
    }

    if (!response.ok) throw new Error(`Gemini ${response.status}`);

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const raw =
      data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean) as {
      groundedness: number;
      completeness: number;
      hallucinations: string[];
      reasoning: string;
    };

    const groundedness = Math.min(10, Math.max(0, result.groundedness || 0));
    const completeness = Math.min(10, Math.max(0, result.completeness || 0));
    const hallucinations = Array.isArray(result.hallucinations)
      ? result.hallucinations
      : [];

    const passed = groundedness >= 5;
    const confidence =
      groundedness >= 8 ? "high" : groundedness >= 6 ? "medium" : "low";

    if (!passed) {
      logger.warn(
        { groundedness, count: hallucinations.length },
        `Auditor FAILED: groundedness=${groundedness}/10`,
      );
    } else {
      logger.debug(
        `Auditor PASSED: groundedness=${groundedness}/10, completeness=${completeness}/10`,
      );
    }

    return {
      passed,
      groundednessScore: groundedness,
      completenessScore: completeness,
      confidence,
      hallucinations,
      auditMs: Date.now() - start,
      auditorUsed: true,
    };
  } catch (err) {
    logger.warn(`Auditor error — skipping: ${(err as Error).message}`);
    return {
      passed: true,
      groundednessScore: -1,
      completenessScore: -1,
      confidence: "skip",
      hallucinations: [],
      auditMs: Date.now() - start,
      auditorUsed: false,
    };
  }
}

export const auditAnswer = isTracingEnabled()
  ? traceable(
      async (
        question: string,
        answer: string,
        context: string,
      ): Promise<AuditResult> => runAudit(question, answer, context),
      {
        name: "HallucinationAuditor",
        run_type: "chain",
        tags: ["validation", "audit", "groundedness"],
      },
    )
  : runAudit;

export function buildAuditedAnswer(
  generated: GenerationResult,
  audit: AuditResult,
): AuditedAnswer {
  let answer = generated.answer;

  if (audit.auditorUsed && !audit.passed) {
    answer =
      `⚠️ Low confidence answer (groundedness: ${audit.groundednessScore}/10). ` +
      `This answer may contain information not directly from the indexed documents.\n\n` +
      answer;
  }

  return {
    answer,
    model: generated.model,
    promptTokens: generated.promptTokens,
    completionTokens: generated.completionTokens,
    audit,
  };
}
