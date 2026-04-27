import { JwtPayload } from "@/core/types/auth.interface";

declare global {
  namespace Express {
    interface Request {
      user: JwtPayload;
    }
  }
}
