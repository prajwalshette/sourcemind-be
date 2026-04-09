// src/services/generator.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// LLM Generation — 5-tier chain with SSE streaming
//
//  TIER 1 → Gemini Flash 2.0   (FREE: 1500 req/day, 30 req/min, best quality)
//  TIER 2 → OpenRouter          (FREE models, streaming supported)
//  TIER 3 → Groq                (FREE, fast, streaming supported)
//  TIER 4 → HuggingFace Router  (FREE, no streaming — falls back to buffered)
//  TIER 5 → Static fallback
// ─────────────────────────────────────────────────────────────────────────────
import { traceable } from "langsmith/traceable";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { CircuitBreaker } from "@utils/circuit-breaker";
import { isTracingEnabled } from "@/tracing/langsmith";
import { GenerationResult } from "@interfaces/query.interface";

// ─── CIRCUIT BREAKERS ────────────────────────────────────────────────────────
const geminiBreaker = new CircuitBreaker({
  name: "gemini",
  failureThreshold: 3,
  timeout: 30_000,
});
const openrouterBreaker = new CircuitBreaker({
  name: "openrouter",
  failureThreshold: 3,
  timeout: 60_000,
});
const hfBreaker = new CircuitBreaker({
  name: "hf-llm",
  failureThreshold: 3,
  timeout: 60_000,
});
const groqBreaker = new CircuitBreaker({
  name: "groq-llm",
  failureThreshold: 3,
  timeout: 30_000,
});

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a precise, helpful question-answering assistant.

CRITICAL RULES:
1. Answer ONLY using information from the provided <context_chunk> tags.
2. If the question is broad (e.g. "tell me everything", "give me all information", "what is X about"), synthesize and summarize ALL relevant information from the context chunks into a comprehensive, well-structured answer.
3. If the context genuinely does not contain the answer and the question is very specific, respond: "I cannot find this information in the provided document."
4. NEVER use your training knowledge to supplement answers — only use the context.
5. Do NOT include markers like "[Source 1]" or "[Source 2]" in the answer. Just write a clean explanation; the system will show sources separately.
6. When the user asks for a guide, steps, quickstart, "how to", or similar, and the context contains instructions, summarize those instructions as clear, numbered steps in your own words instead of just pointing to a link.
7. For overview/summary questions: organize your answer with clear headings or sections if the context covers multiple aspects of the topic.
8. Be thorough for broad questions, concise for specific questions. Do not add unnecessary padding.
9. If the question is unclear, ask for clarification instead of guessing.`;

// ─── GEMINI RATE GUARD ───────────────────────────────────────────────────────
const geminiRateTracker = {
  requests: [] as number[],
  LIMIT_PER_MIN: 28,
  LIMIT_PER_DAY: 1400,
  dailyCount: 0,
  dailyResetAt: Date.now() + 86_400_000,

  canMakeRequest(): boolean {
    const now = Date.now();
    if (now > this.dailyResetAt) {
      this.dailyCount = 0;
      this.dailyResetAt = now + 86_400_000;
    }
    if (this.dailyCount >= this.LIMIT_PER_DAY) return false;
    this.requests = this.requests.filter((t) => now - t < 60_000);
    return this.requests.length < this.LIMIT_PER_MIN;
  },

  record(): void {
    this.requests.push(Date.now());
    this.dailyCount++;
  },
};

// ─── SHARED SSE LINE PARSER ──────────────────────────────────────────────────
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  extractToken: (parsed: unknown) => string | null,
  isDone: (parsed: unknown) => boolean,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        try {
          const parsed: unknown = JSON.parse(data);
          const token = extractToken(parsed);
          if (token) yield token;
          if (isDone(parsed)) return;
        } catch {
          // incomplete JSON chunk — wait for next read
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── TIER 1: GEMINI — STREAMING ────────────────────────────────────────────────
async function* geminiStream(
  prompt: string,
  context: string,
): AsyncGenerator<string> {
  if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  if (!geminiRateTracker.canMakeRequest()) {
    throw new Error("Gemini rate limit guard triggered");
  }

  const model = config.GEMINI_MODEL || "gemini-2.0-flash-exp";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${config.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: `${SYSTEM_PROMPT}\n\n${context}\n\nQuestion: ${prompt}` }],
          role: "user",
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
        topP: 0.9,
        topK: 40,
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 429) {
    throw new Error(`Gemini 429 rate limited`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`Gemini error ${response.status}: ${await response.text()}`);
  }

  geminiRateTracker.record();

  type GeminiChunk = {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
  };

  yield* parseSseStream(
    response.body,
    (parsed) => {
      const chunk = parsed as GeminiChunk;
      return chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    },
    (parsed) => {
      const chunk = parsed as GeminiChunk;
      return chunk.candidates?.[0]?.finishReason === "STOP";
    },
  );
}

async function geminiGenerate(
  prompt: string,
  context: string,
): Promise<GenerationResult> {
  let answer = "";
  for await (const token of geminiStream(prompt, context)) {
    answer += token;
  }
  if (!answer) throw new Error("Gemini returned empty response");
  const model = config.GEMINI_MODEL || "gemini-2.0-flash-exp";
  return { answer, model: `gemini/${model}`, promptTokens: 0, completionTokens: 0 };
}

// ─── TIER 2: OPENROUTER — STREAMING ───────────────────────────────────────────
async function* openrouterStream(
  prompt: string,
  context: string,
): AsyncGenerator<string> {
  if (!config.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");

  const model = config.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.APP_URL || "http://localhost:3000",
      "X-Title": "URL RAG System",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${context}\n\nQuestion: ${prompt}` },
      ],
      temperature: 0.1,
      max_tokens: 1024,
      top_p: 0.9,
      stream: true,
      route: "fallback",
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status === 429) throw new Error("OpenRouter rate limited");
  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter error ${response.status}: ${await response.text()}`);
  }

  type OpenAIChunk = {
    choices?: Array<{
      delta?: { content?: string };
      finish_reason?: string | null;
    }>;
  };

  yield* parseSseStream(
    response.body,
    (parsed) => {
      const chunk = parsed as OpenAIChunk;
      return chunk.choices?.[0]?.delta?.content ?? null;
    },
    (parsed) => {
      const chunk = parsed as OpenAIChunk;
      return chunk.choices?.[0]?.finish_reason === "stop";
    },
  );
}

async function openrouterGenerate(
  prompt: string,
  context: string,
): Promise<GenerationResult> {
  let answer = "";
  for await (const token of openrouterStream(prompt, context)) {
    answer += token;
  }
  if (!answer) throw new Error("OpenRouter returned empty response");
  const model = config.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
  return { answer, model: `openrouter/${model}`, promptTokens: 0, completionTokens: 0 };
}

// ─── TIER 3: GROQ — STREAMING ────────────────────────────────────────────────
async function* groqStream(
  prompt: string,
  context: string,
): AsyncGenerator<string> {
  if (!config.GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${context}\n\nQuestion: ${prompt}` },
      ],
      temperature: 0.1,
      max_tokens: 512,
      top_p: 0.9,
      stream: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Groq error ${response.status}: ${await response.text()}`);
  }

  type OpenAIChunk = {
    choices?: Array<{
      delta?: { content?: string };
      finish_reason?: string | null;
    }>;
  };

  yield* parseSseStream(
    response.body,
    (parsed) => {
      const chunk = parsed as OpenAIChunk;
      return chunk.choices?.[0]?.delta?.content ?? null;
    },
    (parsed) => {
      const chunk = parsed as OpenAIChunk;
      return chunk.choices?.[0]?.finish_reason === "stop";
    },
  );
}

async function groqGenerate(
  prompt: string,
  context: string,
): Promise<GenerationResult> {
  let answer = "";
  for await (const token of groqStream(prompt, context)) {
    answer += token;
  }
  if (!answer) throw new Error("Groq returned empty response");
  return { answer, model: "groq/llama-3.1-8b-instant", promptTokens: 0, completionTokens: 0 };
}

// ─── TIER 4: HUGGINGFACE — BUFFERED ONLY ─────────────────────────────────────
async function hfGenerate(
  prompt: string,
  context: string,
): Promise<GenerationResult> {
  if (!config.HF_API_KEY) throw new Error("HF_API_KEY not configured");

  const HF_MODEL = "mistralai/Mistral-7B-Instruct-v0.3";
  const fullPrompt = `<s>[INST] ${SYSTEM_PROMPT}\n\n${context}\n\nQuestion: ${prompt} [/INST]`;

  const response = await fetch(
    `https://router.huggingface.co/hf-inference/models/${HF_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: fullPrompt,
        parameters: {
          max_new_tokens: 512,
          temperature: 0.1,
          do_sample: true,
          return_full_text: false,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );

  if (!response.ok) {
    throw new Error(`HuggingFace error ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as Array<{ generated_text: string }>;
  const answer = data[0]?.generated_text?.trim() || "";
  if (!answer) throw new Error("HuggingFace returned empty response");

  return { answer, model: `hf/${HF_MODEL}`, promptTokens: 0, completionTokens: 0 };
}

// ─── TIER 5: STATIC FALLBACK ───────────────────────────────────────────────────
async function staticFallback(): Promise<GenerationResult> {
  logger.error("All LLM providers failed — returning graceful error");
  return {
    answer:
      "I apologize, but the AI service is temporarily unavailable. " +
      "Please try again in a few minutes. Your documents are safely indexed and ready when the service recovers.",
    model: "static-fallback",
    promptTokens: 0,
    completionTokens: 0,
  };
}

const tracedGeminiGenerate = traceable(
  (p: string, c: string) => geminiGenerate(p, c),
  { name: "GeminiLLM", run_type: "llm", tags: ["generation", "gemini"] },
);
const tracedOpenrouterGenerate = traceable(
  (p: string, c: string) => openrouterGenerate(p, c),
  { name: "OpenRouterLLM", run_type: "llm", tags: ["generation", "openrouter"] },
);
const tracedGroqGenerate = traceable(
  (p: string, c: string) => groqGenerate(p, c),
  { name: "GroqLLM", run_type: "llm", tags: ["generation", "groq", "fallback"] },
);
const tracedHfGenerate = traceable(
  (p: string, c: string) => hfGenerate(p, c),
  {
    name: "HuggingFaceLLM",
    run_type: "llm",
    tags: ["generation", "huggingface", "fallback"],
  },
);

interface Provider {
  name: string;
  breaker: CircuitBreaker;
  stream: (prompt: string, context: string) => AsyncGenerator<string>;
  generate: (prompt: string, context: string) => Promise<GenerationResult>;
}

function buildProviders(tracing: boolean): Provider[] {
  const providers: Provider[] = [];

  if (config.GEMINI_API_KEY) {
    providers.push({
      name: "Gemini",
      breaker: geminiBreaker,
      stream: geminiStream,
      generate: tracing ? tracedGeminiGenerate : geminiGenerate,
    });
  }
  if (config.OPENROUTER_API_KEY) {
    providers.push({
      name: "OpenRouter",
      breaker: openrouterBreaker,
      stream: openrouterStream,
      generate: tracing ? tracedOpenrouterGenerate : openrouterGenerate,
    });
  }
  if (config.GROQ_API_KEY) {
    providers.push({
      name: "Groq",
      breaker: groqBreaker,
      stream: groqStream,
      generate: tracing ? tracedGroqGenerate : groqGenerate,
    });
  }
  if (config.HF_API_KEY) {
    providers.push({
      name: "HuggingFace",
      breaker: hfBreaker,
      stream: async function* (p, c) {
        const result = await hfGenerate(p, c);
        yield result.answer;
      },
      generate: tracing ? tracedHfGenerate : hfGenerate,
    });
  }

  return providers;
}

function modelLabelForProvider(name: string): string {
  const geminiM = config.GEMINI_MODEL || "gemini-2.0-flash-exp";
  const orM = config.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
  switch (name) {
    case "Gemini":
      return `gemini/${geminiM}`;
    case "OpenRouter":
      return `openrouter/${orM}`;
    case "Groq":
      return "groq/llama-3.1-8b-instant";
    case "HuggingFace":
      return "hf/mistralai/Mistral-7B-Instruct-v0.3";
    default:
      return "unknown";
  }
}

export type StreamAnswerEvent =
  | { type: "model"; model: string }
  | { type: "token"; text: string };

/**
 * Same provider chain as generateAnswer, but yields model (once) then tokens.
 */
export async function* streamAnswerEvents(
  question: string,
  context: string,
): AsyncGenerator<StreamAnswerEvent> {
  const providers = buildProviders(isTracingEnabled());

  if (providers.length === 0) {
    logger.error("No LLM providers configured");
    const fb = await staticFallback();
    yield { type: "model", model: fb.model };
    yield { type: "token", text: fb.answer };
    return;
  }

  logger.debug(`Stream chain: ${providers.map((p) => p.name).join(" → ")} → Static`);

  for (const provider of providers) {
    try {
      let yieldedAny = false;
      let announcedModel = false;

      const generator = await provider.breaker.execute(
        () => Promise.resolve(provider.stream(question, context)),
        async () => {
          throw new Error(`${provider.name} circuit open`);
        },
      );

      for await (const token of generator) {
        if (!announcedModel) {
          yield { type: "model", model: modelLabelForProvider(provider.name) };
          announcedModel = true;
        }
        yieldedAny = true;
        yield { type: "token", text: token };
      }

      if (yieldedAny) return;
    } catch (err) {
      logger.warn(
        { tier: provider.name.toLowerCase(), err: (err as Error).message },
        `${provider.name} stream failed → next`,
      );
    }
  }

  const fb = await staticFallback();
  yield { type: "model", model: fb.model };
  yield { type: "token", text: fb.answer };
}

/**
 * Streams answer tokens through the provider chain (same fallback order as generateAnswer).
 */
export async function* streamAnswer(
  question: string,
  context: string,
): AsyncGenerator<string> {
  for await (const ev of streamAnswerEvents(question, context)) {
    if (ev.type === "token") yield ev.text;
  }
}

export async function generateAnswer(
  question: string,
  context: string,
): Promise<GenerationResult> {
  const providers = buildProviders(isTracingEnabled());

  if (providers.length === 0) {
    logger.error("No LLM providers configured");
    return staticFallback();
  }

  logger.debug(`LLM chain: ${providers.map((p) => p.name).join(" → ")} → Static`);

  for (const provider of providers) {
    try {
      const result = await provider.breaker.execute(
        () => provider.generate(question, context),
        async () => {
          throw new Error(`${provider.name} circuit open`);
        },
      );
      if (result.answer) return result;
    } catch (err) {
      logger.warn(
        { tier: provider.name.toLowerCase(), err: (err as Error).message },
        `${provider.name} failed → next`,
      );
    }
  }

  return staticFallback();
}

export function getGeminiRateStatus() {
  const now = Date.now();
  const recentRequests = geminiRateTracker.requests.filter(
    (t) => now - t < 60_000,
  ).length;
  return {
    requestsPerMin: recentRequests,
    limitPerMin: geminiRateTracker.LIMIT_PER_MIN,
    dailyCount: geminiRateTracker.dailyCount,
    limitPerDay: geminiRateTracker.LIMIT_PER_DAY,
    canMakeRequest: geminiRateTracker.canMakeRequest(),
  };
}
