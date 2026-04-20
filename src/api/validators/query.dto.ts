import { z } from "zod";
import { querySchema, historySchema } from "@/api/validators/query.schema";

export type QueryDto = z.infer<typeof querySchema>;
export type QueryHistoryDto = z.infer<typeof historySchema>;
