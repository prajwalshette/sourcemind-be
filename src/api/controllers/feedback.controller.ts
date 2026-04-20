
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  logRunFeedback,
  addExampleToDataset,
  isTracingEnabled,
} from "@/config/tracing";

const feedbackSchema = z.object({
  runId: z.string().min(1),
  score: z.number().min(0).max(1),
  key: z
    .enum(["correctness", "faithfulness", "relevance", "helpful"])
    .default("correctness"),
  comment: z.string().max(1000).optional(),
  saveAsExample: z.boolean().default(false),
  question: z.string().optional(),
  expectedAnswer: z.string().optional(),
});

// POST /api/v1/feedback
export async function submitFeedback(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!isTracingEnabled()) {
      res.status(200).json({
        success: true,
        message:
          "Feedback received (LangSmith tracing disabled — enable LANGCHAIN_TRACING_V2=true to persist)",
      });
      return;
    }

    const body = feedbackSchema.parse(req.body);

    await logRunFeedback(body.runId, body.key, body.score, body.comment);

    if (body.saveAsExample && body.question && body.expectedAnswer) {
      await addExampleToDataset(
        "rag-golden-set",
        { question: body.question },
        { answer: body.expectedAnswer, score: body.score },
      );
    }

    res.json({
      success: true,
      message: `Feedback submitted to LangSmith (runId=${body.runId}, ${body.key}=${body.score})`,
      dashboard: "https://smith.langchain.com",
    });
  } catch (err) {
    next(err);
  }
}
