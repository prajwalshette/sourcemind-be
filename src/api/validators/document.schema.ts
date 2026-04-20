import { z } from "zod";

export const ingestSchema = z.object({
  url: z.string().url(),
  async: z.boolean().default(true),
  webhookUrl: z.string().url().optional(),
  crawlAllPages: z.boolean().optional(),
  maxPages: z.coerce.number().int().min(1).max(200).optional(),
});

export const listSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(200).default(20),
  status: z.string().optional(),
  siteKey: z.string().optional(),
  rootOnly: z.preprocess((val) => val === "true" || val === true, z.boolean().optional()),
});
