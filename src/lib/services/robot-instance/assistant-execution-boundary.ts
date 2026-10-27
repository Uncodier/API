/** Trusted replacement for canonical site charging, not an additional charge. */
export interface AssistantExecutionBoundaryBilling {
  /** Once per logical request after beforeModel. Includes the full final JSON payload in UTF-8 bytes.
   * The adapter owns reconciliation if this hook rejects after reserving/marking dispatch. */
  beforeDispatch(input: { eventId: string; inputBytes: number; maxOutputTokens: number }): Promise<void>;
  /** Once on accepted completion, before response validation or tool execution. */
  settle(input: { eventId: string; usage: unknown; generationId?: string; model?: string }): Promise<void>;
  /** Once on exhausted/failed admission after beforeDispatch resolved; not on settle failure. */
  failed(input: { eventId: string; error: unknown; model?: string }): Promise<void>;
}

/** Host-provided execution callbacks. Never populate this interface from request JSON. */
export interface AssistantExecutionBoundary {
  /** Final provider payload, before each actual request (including admission retries). */
  beforeModel(input: { system: string; messages: any[]; tools: any[]; maxOutputTokens: number }): Promise<void>;
  /** Validated response with truncated calls removed and final parsed/coerced/overridden arguments, before effects. */
  onModelMessage(message: any): Promise<void>;
  /** Stable provider call ID and approved arguments; execute is memoized to one effect attempt.
   * Unknown/invalid/skipped calls also pass through this hook with a synthetic non-executed failure. */
  executeTool(call: { id: string; name: string; args: any }, execute: () => Promise<any>): Promise<any>;
  /** Complete turn transcript after tool processing and awaited canonical onStep. */
  afterTurn(messages: any[]): Promise<void>;
  signal?: AbortSignal;
  redact?(value: string): string;
  billing?: AssistantExecutionBoundaryBilling;
}

/** Fatal to existing recovery-aware catches; never expose hook payloads in the message. */
export class AssistantExecutionBoundaryError extends Error {
  constructor(public readonly code: 'boundary_failed' | 'execution_check_failed' | 'session_lease_failed' | 'session_save_failed' = 'boundary_failed') {
    super('Assistant execution boundary failed');
    this.name = 'RecoveryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}