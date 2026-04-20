import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  createSession,
  listSessions,
  getSessionThread,
  updateSessionTitle,
  deleteSession,
} from "@/core/services/auth/chat-session.service";
import { HttpException } from "@/core/exceptions/httpException";

const createSessionSchema = z.object({
  title: z.string().max(100).optional(),
  siteKey: z.string().url().optional(),
  documentId: z.string().uuid().optional(),
});

const listSessionsSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
});

const updateTitleSchema = z.object({
  title: z.string().min(1).max(100),
});

export async function createSessionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = createSessionSchema.parse(req.body);
    const session = await createSession(body);
    res.status(201).json({ success: true, data: session });
  } catch (err) {
    next(err);
  }
}

export async function listSessionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { page, limit } = listSessionsSchema.parse(req.query);
    const { sessions, total } = await listSessions({ page, limit });
    res.json({
      success: true,
      data: sessions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

export async function getSessionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getSessionThread(String(req.params.id));
    if (!result) throw new HttpException(404, "Session not found");
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateSessionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { title } = updateTitleSchema.parse(req.body);
    await updateSessionTitle(String(req.params.id), title);
    res.json({ success: true, message: "Title updated" });
  } catch (err) {
    next(err);
  }
}

export async function deleteSessionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await deleteSession(String(req.params.id));
    res.json({ success: true, message: "Session deleted" });
  } catch (err) {
    next(err);
  }
}

