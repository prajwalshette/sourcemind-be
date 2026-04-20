
import { Client } from 'langsmith';
import { traceable } from 'langsmith/traceable';
import { config } from '@config/env';
import { logger } from '../utils/logger';

// ─── CLIENT SINGLETON ────────────────────────────────────────────────────────
let _client: Client | null = null;

export function getLangSmithClient(): Client | null {
  if (!isTracingEnabled()) return null;

  if (!_client) {
    _client = new Client({
      apiKey: config.LANGCHAIN_API_KEY,
      apiUrl: 'https://api.smith.langchain.com',
    });
  }
  return _client;
}

export function isTracingEnabled(): boolean {
  return (
    config.LANGCHAIN_TRACING_V2 === 'true' &&
    config.LANGCHAIN_API_KEY.length > 0
  );
}

// ─── SET ENV VARS FOR LANGCHAIN AUTO-TRACING ─────────────────────────────────
// LangChain libraries automatically pick these up from process.env
export function initLangSmith(): void {
  if (!isTracingEnabled()) {
    logger.info('LangSmith tracing DISABLED (set LANGCHAIN_TRACING_V2=true to enable)');
    return;
  }

  // These env vars are read by LangChain SDK automatically
  process.env.LANGCHAIN_TRACING_V2   = 'true';
  process.env.LANGCHAIN_API_KEY      = config.LANGCHAIN_API_KEY;
  process.env.LANGCHAIN_PROJECT      = config.LANGCHAIN_PROJECT;
  process.env.LANGCHAIN_ENDPOINT     = 'https://api.smith.langchain.com';

  logger.info(`✅ LangSmith tracing ENABLED → project: "${config.LANGCHAIN_PROJECT}"`);
  logger.info(`   Dashboard: https://smith.langchain.com/projects`);
}

// ─── TRACEABLE WRAPPER (no-op when disabled) ──────────────────────────────────
// Usage:
//   const fn = wrapTraceable(async (x) => x, { name: 'myFn' })
//   await fn(input)
export function wrapTraceable<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: {
    name: string;
    runType?: 'chain' | 'retriever' | 'llm' | 'tool' | 'embedding';
    tags?: string[];
    metadata?: Record<string, unknown>;
  },
): (...args: TArgs) => Promise<TReturn> {
  if (!isTracingEnabled()) return fn; // passthrough when disabled

  return traceable(fn, {
    name: options.name,
    run_type: options.runType ?? 'chain',
    tags: options.tags ?? [],
    metadata: {
      project: config.LANGCHAIN_PROJECT,
      ...options.metadata,
    },
  }) as (...args: TArgs) => Promise<TReturn>;
}

// ─── MANUAL RUN LOGGING ───────────────────────────────────────────────────────
// Use this to log custom events / feedback that aren't auto-traced
export async function logRunFeedback(
  runId: string,
  key: 'correctness' | 'faithfulness' | 'relevance' | 'latency' | string,
  score: number,        // 0.0 – 1.0
  comment?: string,
): Promise<void> {
  const client = getLangSmithClient();
  if (!client) return;

  try {
    await client.createFeedback(runId, key, {
      score,
      comment,
      sourceInfo: { source: 'api', feedbackType: 'human' },
    });
    logger.debug(`LangSmith feedback logged: runId=${runId} ${key}=${score}`);
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "LangSmith feedback error");
  }
}

// ─── DATASET HELPERS ─────────────────────────────────────────────────────────
// Create eval datasets to track quality over time
export async function addExampleToDataset(
  datasetName: string,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
): Promise<void> {
  const client = getLangSmithClient();
  if (!client) return;

  try {
    // Get or create dataset
    let dataset;
    try {
      dataset = await client.readDataset({ datasetName });
    } catch {
      dataset = await client.createDataset(datasetName, {
        description: 'RAG evaluation examples',
      });
    }

    await client.createExample(inputs, outputs, { datasetId: dataset.id });
    logger.debug(`LangSmith example added to dataset: ${datasetName}`);
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "LangSmith dataset error");
  }
}