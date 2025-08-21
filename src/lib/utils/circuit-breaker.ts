/**
 * Circuit Breaker Pattern Implementation
 * 
 * Prevents cascading failures by monitoring error rates and temporarily
 * stopping requests when failure threshold is exceeded.
 */

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Failing, rejecting requests
  HALF_OPEN = 'HALF_OPEN' // Testing if service recovered
}

export interface CircuitBreakerOptions {
  failureThreshold: number;    // Number of failures before opening
  recoveryTimeout: number;     // Time to wait before trying again (ms)
  monitoringPeriod: number;    // Time window for failure counting (ms)
  expectedErrorTypes?: string[]; // Error types that should trigger circuit
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private nextAttemptTime: number = 0;
  
  constructor(
    private name: string,
    private options: CircuitBreakerOptions
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        throw new Error(`Circuit breaker [${this.name}] is OPEN. Next attempt at ${new Date(this.nextAttemptTime).toISOString()}`);
      } else {
        this.state = CircuitState.HALF_OPEN;
        console.log(`🔄 Circuit breaker [${this.name}] moving to HALF_OPEN state`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      console.log(`✅ Circuit breaker [${this.name}] recovered, moving to CLOSED state`);
    }
  }

  private onFailure(error: any): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    // Check if this error type should trigger the circuit
    if (this.options.expectedErrorTypes && this.options.expectedErrorTypes.length > 0) {
      const errorMessage = error?.message || String(error);
      const shouldTrigger = this.options.expectedErrorTypes.some(type => 
        errorMessage.toLowerCase().includes(type.toLowerCase())
      );
      
      if (!shouldTrigger) {
        console.log(`⚠️ Circuit breaker [${this.name}] ignoring error type: ${errorMessage}`);
        return;
      }
    }

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = Date.now() + this.options.recoveryTimeout;
      console.error(`🚨 Circuit breaker [${this.name}] OPENED after ${this.failureCount} failures. Next attempt: ${new Date(this.nextAttemptTime).toISOString()}`);
    } else {
      console.warn(`⚠️ Circuit breaker [${this.name}] failure ${this.failureCount}/${this.options.failureThreshold}`);
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats(): {
    state: CircuitState;
    failureCount: number;
    lastFailureTime: number;
    nextAttemptTime: number;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime
    };
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.nextAttemptTime = 0;
    console.log(`🔄 Circuit breaker [${this.name}] manually reset`);
  }
}

// Global circuit breakers for common operations
export const circuitBreakers = {
  database: new CircuitBreaker('database', {
    failureThreshold: 5,
    recoveryTimeout: 30000, // 30 seconds
    monitoringPeriod: 60000, // 1 minute
    expectedErrorTypes: ['fetch failed', 'connection', 'timeout', 'ECONNREFUSED']
  }),
  
  commandProcessing: new CircuitBreaker('command-processing', {
    failureThreshold: 3,
    recoveryTimeout: 15000, // 15 seconds
    monitoringPeriod: 30000, // 30 seconds
    expectedErrorTypes: ['fetch failed', 'TypeError', 'command not found']
  })
};
