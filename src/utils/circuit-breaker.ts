import { logger } from "./logger";

type AsyncFn<T> = () => Promise<T>;
type State = "CLOSED" | "OPEN" | "HALF_OPEN";

import { CircuitBreakerOptions } from "@/core/types/common.interface";

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private readonly opts: Required<CircuitBreakerOptions>;

  constructor(opts: CircuitBreakerOptions) {
    this.opts = {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 30_000,
      ...opts,
    };
  }

  get currentState(): State {
    return this.state;
  }

  async execute<T>(primary: AsyncFn<T>, fallback?: AsyncFn<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.opts.timeout) {
        this.state = "HALF_OPEN";
        logger.info(
          `[CircuitBreaker:${this.opts.name}] → HALF_OPEN (testing recovery)`,
        );
      } else {
        if (fallback) {
          logger.warn(
            `[CircuitBreaker:${this.opts.name}] OPEN → using fallback`,
          );
          return fallback();
        }
        throw new Error(
          `[CircuitBreaker:${this.opts.name}] Circuit OPEN, no fallback available`,
        );
      }
    }

    try {
      const result = await primary();
      this.onSuccess();
      return result;
    } catch (err) {
      const error = err as Error;
      this.onFailure(error);
      if (fallback) {
        logger.warn(
          { err: error.message, stack: error.stack },
          `[CircuitBreaker:${this.opts.name}] Primary failed → fallback`,
        );
        return fallback();
      }
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    if (this.state === "HALF_OPEN") {
      this.successes++;
      if (this.successes >= this.opts.successThreshold) {
        this.state = "CLOSED";
        this.successes = 0;
        logger.info(`[CircuitBreaker:${this.opts.name}] → CLOSED (recovered)`);
      }
    }
  }

  private onFailure(err: Error) {
    this.failures++;
    this.lastFailureTime = Date.now();
    this.successes = 0;

    if (
      this.state === "HALF_OPEN" ||
      this.failures >= this.opts.failureThreshold
    ) {
      this.state = "OPEN";
      logger.error(
        { error: err.message },
        `[CircuitBreaker:${this.opts.name}] → OPEN after ${this.failures} failures`,
      );
    }
  }

  getStatus() {
    return {
      name: this.opts.name,
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
    };
  }
}
