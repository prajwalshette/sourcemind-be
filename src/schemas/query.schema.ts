import { z } from "zod";

export const querySchema = z.object({
  question: z.string().min(3).max(2000),
  documentId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  /** Search all pages of a site crawl — use instead of documentId for site-wide queries */
  siteKey: z.string().url().optional(),
  topK: z.coerce.number().min(1).max(20).default(5),
  useCache: z.boolean().default(true),
  skipIntelligence: z.boolean().optional(),
  useHybrid: z.boolean().default(true),
  skipAudit: z.boolean().default(false),
  skipQueryExpansion: z.boolean().optional(),
  domain: z.string().optional(),
  sourceType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
});

export const historySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  documentId: z.string().uuid().optional(),
});
