/** Portable contracts. No Next, database, sandbox SDK or product state imports. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SessionStatus = 'queued' | 'running' | 'completed' | 'waiting' | 'paused' | 'failed' | 'cancelled';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Provider-owned reasoning must survive continuation without reinterpretation. */
  reasoningDetails?: Json[];
}

export interface ToolResult {
  ok: boolean;
  output?: Json;
  error?: { code: string; message: string; ambiguous?: boolean; effectStarted?: boolean };
}

export type Reconciliation =
  | { state: 'applied'; proof: string; result: ToolResult }
  | { state: 'not_applied'; proof: string }
  | { state: 'retry_safe'; proof: string }
  | { state: 'unknown' };

export interface ToolContext {
  sessionId: string;
  operationId: string;
  signal: AbortSignal;
  assertActive(): Promise<void>;
}

export interface HarnessTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: 'read' | 'write';
  /** Pure host adapter validation/canonicalization, before identity and dispatch.
   * Must preserve the meaning of the effect; never perform I/O here. */
  normalizeArguments?(args: Record<string, unknown>): Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  /** Trusted adapter only: model prose/inspection claims never authorize a replay. */
  reconcile?(args: Record<string, unknown>, context: ToolContext): Promise<Reconciliation>;
}

export interface WorkspaceRef {
  provider: 'vercel';
  id: string;
  root: string;
}

export interface CommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
  /** Host-configured, project-scoped app environment only. Never the host process environment. */
  useRuntimeEnvironment?: boolean;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  processId?: string;
  truncated?: boolean;
}

export interface Workspace {
  ref: WorkspaceRef;
  readFile(path: string, signal?: AbortSignal): Promise<string>;
  writeFile(path: string, content: string, signal?: AbortSignal): Promise<void>;
  exec(input: CommandInput, signal?: AbortSignal): Promise<CommandOutput>;
  processStatus(id: string, signal?: AbortSignal): Promise<CommandOutput>;
  stopProcess(id: string, signal?: AbortSignal): Promise<void>;
  /** Persist workspace independently of tests, commits, pushes or deployments. */
  suspend(): Promise<void>;
}

export interface SessionLimits {
  maxTurns: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxActiveMs: number;
}

export interface SessionRequest {
  objective: string;
  repository?: { url: string; ref?: string };
  /** Immutable host-selected resource family; legacy sessions are workspace. */
  executionEnvironment?: 'cloud' | 'workspace';
  /** Cloud document scope stays pinned if a runner is archived/replaced. */
  cloudInstanceId?: string;
  limits: SessionLimits;
  /** Server-configured capabilities/credentials profile identifier; not credentials. */
  profile?: string;
  /** Product adapter provenance only; standalone clients cannot set this. */
  requirementId?: string;
}

export interface PendingOperation {
  call: ToolCall;
  fingerprint: string;
  effect: 'read' | 'write';
}

export interface HarnessSession {
  id: string;
  version: number;
  status: SessionStatus;
  request: SessionRequest;
  messages: Message[];
  workspace?: WorkspaceRef;
  turns: number;
  /** Reserved before model dispatch; unknown provider usage is never refunded. */
  allocatedTokens: number;
  activeMs: number;
  pending?: PendingOperation;
  uncertainOperations: string[];
  reconciledOperations?: Record<string, { operationId: string; proof: string;
    state: 'applied' | 'not_applied' | 'retry_safe'; result?: ToolResult }>;
  reason?: string;
  /** Host-recorded rejected model hold; positive balance alone cannot resume it. */
  creditRecoveryMinimum?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionScope {
  siteId: string;
  userId: string;
}

/** Host-only encrypted state. Never included in a HarnessSession or model message. */
export interface HostConfiguration {
  layers: Record<string, { values: Record<string, string>; expiresAt?: string;
    refresh?: { kind: 'tenant'; requirementId: string } }>;
  redactionValues: string[];
}

export interface HostStateStore {
  load(id: string, siteId: string, owner: string): Promise<{ version: number; configuration: HostConfiguration }>;
  save(id: string, siteId: string, owner: string, expectedVersion: number, configuration: HostConfiguration): Promise<number>;
}

export interface ResultArtifact {
  id: string;
  bytes: number;
  chars: number;
}

export interface ArtifactStore {
  reserve(sessionId: string, siteId: string, owner: string, operationId: string, bytes: number): Promise<void>;
  /** Complete redacted content; bounded per artifact. Must be durable before recording its reference. */
  put(sessionId: string, siteId: string, owner: string, operationId: string, text: string): Promise<ResultArtifact>;
  read(sessionId: string, siteId: string, owner: string, id: string, offset: number, limit: number): Promise<{
    text: string; totalChars: number; nextOffset: number | null;
  } | null>;
}

export interface SessionStore {
  create(session: HarnessSession, scope: SessionScope): Promise<void>;
  load(id: string, siteId: string): Promise<HarnessSession | null>;
  claim(id: string, siteId: string, owner: string, ttlSeconds: number): Promise<HarnessSession | null>;
  save(session: HarnessSession, siteId: string, owner: string): Promise<HarnessSession>;
  assertOwner(id: string, siteId: string, owner: string, ttlSeconds: number): Promise<void>;
  release(id: string, siteId: string, owner: string): Promise<void>;
  control(id: string, siteId: string, action: 'pause' | 'cancel' | 'resume', message?: string): Promise<HarnessSession | null>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported USD cost, including zero; never inferred from tokens. */
  cost?: number;
}

export interface ModelBillingEvidence {
  usage?: ModelUsage;
  generationId?: string;
  model?: string;
  /** Trusted adapter proof of rejection before any generation was accepted. */
  admissionRejected?: boolean;
}

export interface ModelReply extends ModelBillingEvidence {
  message: Message;
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface HarnessModel {
  respond(input: { system: string; messages: Message[]; tools: HarnessTool[]; maxOutputTokens: number; signal: AbortSignal }): Promise<ModelReply>;
}