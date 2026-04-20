import { z } from "zod";
import { ingestSchema, listSchema } from "@/api/validators/document.schema";

export type IngestDto = z.infer<typeof ingestSchema>;
export type ListDocumentsDto = z.infer<typeof listSchema>;
