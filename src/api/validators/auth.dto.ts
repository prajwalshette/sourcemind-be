import { z } from "zod";
import { registerSchema, loginSchema } from "@/api/validators/auth.schema";

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
