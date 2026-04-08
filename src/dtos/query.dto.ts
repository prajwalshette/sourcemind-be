import { z } from "zod";
import { querySchema, historySchema } from "@schemas/query.schema";

export type QueryDto = z.infer<typeof querySchema>;
export type QueryHistoryDto = z.infer<typeof historySchema>;
