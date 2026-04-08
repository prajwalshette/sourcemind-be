import { Request, Response, NextFunction } from "express";
import {
  register as registerService,
  login as loginService,
  getMe as getMeService,
} from "@services/auth.service";
import { registerSchema, loginSchema } from "@schemas/auth.schema";
import { RegisterDto, LoginDto } from "@dtos/auth.dto";

export async function register(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body: RegisterDto = registerSchema.parse(req.body);
    const result = await registerService(body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function login(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body: LoginDto = loginSchema.parse(req.body);
    const result = await loginService(body);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getMe(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = (req as any).user!.userId as string;
    const user = await getMeService(userId);
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}
