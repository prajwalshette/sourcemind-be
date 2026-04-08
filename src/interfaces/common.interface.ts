export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number; // failures before opening
  successThreshold?: number; // successes in HALF_OPEN to close
  timeout?: number; // ms to wait before trying HALF_OPEN
}
