import { ChatSession as PrismaChatSession, QueryLog } from "@generated/prisma";
import { prisma } from "@/infrastructure/database/prisma.client";
import { deleteCache, getCache, setCache } from "@/infrastructure/database/redis.client";
import { logger } from "@utils/logger";

const MAX_HISTORY_TURNS = 5;
const CACHE_TURNS = 10;
const SESSION_TTL_SECONDS = 2 * 60 * 60;

export interface SessionTurn {
  turnIndex: number;
  question: string;
  answer: string;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string | null;
  siteKey: string | null;
  documentId: string | null;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function createSession(opts: {
  title?: string;
  siteKey?: string;
  documentId?: string;
}): Promise<ChatSession> {
  const session = await prisma.chatSession.create({
    data: {
      title: opts.title ?? null,
      siteKey: opts.siteKey ?? null,
      documentId: opts.documentId ?? null,
      turnCount: 0,
    },
  });

  logger.debug({ sessionId: session.id }, "Chat session created");

  return {
    id: session.id,
    title: session.title,
    siteKey: session.siteKey,
    documentId: session.documentId,
    turnCount: session.turnCount,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

export async function listSessions(opts: {
  page: number;
  limit: number;
}): Promise<{ sessions: ChatSession[]; total: number }> {
  const skip = (opts.page - 1) * opts.limit;

  const [rows, total] = await Promise.all([
    prisma.chatSession.findMany({
      orderBy: { updatedAt: "desc" },
      skip,
      take: opts.limit,
      include: {
        turns: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { question: true },
        },
      },
    }),
    prisma.chatSession.count(),
  ]);

  return {
    sessions: rows.map((s: PrismaChatSession & { turns: { question: string | null }[] }) => ({
      id: s.id,
      title: s.title ?? s.turns[0]?.question?.slice(0, 60) ?? "New chat",
      siteKey: s.siteKey,
      documentId: s.documentId,
      turnCount: s.turnCount,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
    total,
  };
}

export async function getSessionThread(
  sessionId: string,
): Promise<{ session: ChatSession; turns: SessionTurn[] } | null> {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    include: {
      turns: {
        orderBy: { turnIndex: "asc" },
        select: {
          turnIndex: true,
          question: true,
          answer: true,
          createdAt: true,
        },
      },
    },
  });

  if (!session) return null;

  return {
    session: {
      id: session.id,
      title: session.title,
      siteKey: session.siteKey,
      documentId: session.documentId,
      turnCount: session.turnCount,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    },
    turns: session.turns.map((t: Pick<QueryLog, 'turnIndex' | 'question' | 'answer' | 'createdAt'>) => ({
      turnIndex: t.turnIndex,
      question: t.question,
      answer: t.answer ?? "",
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { title: title.slice(0, 100) },
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.chatSession.delete({ where: { id: sessionId } });
  await deleteCache(`session:${sessionId}:turns`);
  logger.debug({ sessionId }, "Chat session deleted");
}

export async function appendTurn(
  sessionId: string,
  queryLogId: string,
  question: string,
  answer: string,
): Promise<void> {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { turnCount: true, title: true },
  });
  if (!session) return;

  const nextIndex = session.turnCount + 1;

  await prisma.queryLog.update({
    where: { id: queryLogId },
    data: { sessionId, turnIndex: nextIndex },
  });

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      turnCount: nextIndex,
      ...(nextIndex === 1 && !session.title ? { title: question.slice(0, 60) } : {}),
    },
  });

  await refreshSessionCache(sessionId);
}

export async function getHistoryForPrompt(sessionId: string): Promise<string> {
  const turns = await getCachedTurns(sessionId);
  if (turns.length === 0) return "";

  const recent = turns.slice(-MAX_HISTORY_TURNS);
  const lines = recent.map(
    (t) => `Turn ${t.turnIndex}:\nUser: ${t.question}\nAssistant: ${t.answer}`,
  );

  return `Previous conversation:\n${lines.join("\n\n")}\n\n`;
}

async function getCachedTurns(sessionId: string): Promise<SessionTurn[]> {
  const cacheKey = `session:${sessionId}:turns`;

  try {
    const cached = await getCache<SessionTurn[]>(cacheKey);
    if (cached) return cached;
  } catch {
    // ignore cache errors; fall back to DB
  }

  return refreshSessionCache(sessionId);
}

async function refreshSessionCache(sessionId: string): Promise<SessionTurn[]> {
  const turns = await prisma.queryLog.findMany({
    where: { sessionId },
    orderBy: { turnIndex: "asc" },
    take: CACHE_TURNS,
    select: {
      turnIndex: true,
      question: true,
      answer: true,
      createdAt: true,
    },
  });

  const formatted: SessionTurn[] = turns.map((t: Pick<QueryLog, 'turnIndex' | 'question' | 'answer' | 'createdAt'>) => ({
    turnIndex: t.turnIndex,
    question: t.question,
    answer: t.answer ?? "",
    createdAt: t.createdAt.toISOString(),
  }));

  await setCache(`session:${sessionId}:turns`, formatted, SESSION_TTL_SECONDS);
  return formatted;
}

