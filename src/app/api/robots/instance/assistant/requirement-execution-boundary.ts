import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssistantExecutionBoundaryError, type AssistantExecutionBoundary } from '@/lib/services/robot-instance/assistant-execution-boundary';
import { persistResult, RECEIPT_MAX_BYTES, RESULT_MAX_BYTES, serializedBytes, SNAPSHOT_MAX_BYTES } from '@/lib/harness/engine-results';
import { operationFingerprint, redactData, safeError } from '@/lib/harness/security';
import { sameJson } from '@/lib/harness/store';
import type { RequirementRun } from '@/lib/harness/requirement-types';
import type { ArtifactStore, HarnessSession, HarnessTool, Message, SessionStore, ToolCall, ToolContext, ToolResult } from '@/lib/harness/types';
import { requirementOperationFingerprint, requirementOperationResult } from './requirement-operation';

type LogEvent = { key: string; log_type: string; message: string; tool_name?: string; tool_call_id?: string;
  tool_args?: any; tool_result?: any; is_error?: boolean; details?: Record<string, unknown> };
type Input = { session: HarnessSession; store: SessionStore; owner: string; run: RequirementRun;
  artifacts: ArtifactStore; redact: (s: string) => string; assertActive: () => Promise<void>;
  signal: AbortSignal; tools: HarnessTool[]; writeLog: (event: LogEvent) => Promise<void>;
  onCheckpoint?: (context: { owner: string; assertActive: () => Promise<void>; signal: AbortSignal }) => Promise<void> };
// Optional JSON snapshot extension: old snapshots need no schema migration.
type AssistantSession = HarnessSession & { assistantAuditCursor?: number; assistantExecutionVersion?: 0 | 1 };

const callSchema = z.object({ id: z.string().min(1).max(200), name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  arguments: z.string().max(100000) });
const finishSchema = z.object({ summary: z.string().min(1).max(24000), outcome: z.enum(['implemented', 'partial', 'unable']) }).strict();
const historySchema = z.object({ offset: z.number().int().min(0), limit: z.number().int().min(1).max(10).default(5) }).strict();
const artifactSchema = z.object({ id: z.string().min(1).max(200), offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(8000).default(4000) }).strict();
const reconcileSchema = z.object({ operationId: z.string().min(1).max(200) }).strict();

function canonical(message: Message): any {
  return { role: message.role, content: message.content,
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function',
      function: { name: call.name, arguments: call.arguments } })) } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.reasoningDetails ? { reasoning_details: message.reasoningDetails } : {}) };
}

/** Durability adapter only. The canonical assistant owns inference, routing and execution wrappers. */
export function createRequirementExecutionBoundary(input: Input): {
  boundary: AssistantExecutionBoundary; getSession: () => HarnessSession; getMessages: () => any[];
  initialize: () => Promise<void>; finish: () => Promise<void>; controlTools: any[];
  executeHarnessTool: (name: string, args: any) => Promise<ToolResult>;
} {
  let session: AssistantSession = structuredClone(input.session);
  let confirmedSession = structuredClone(session);
  let measuredAt = Date.now();
  let initialized = false;
  let poisoned = false;
  let awaitingModel = false;
  let executing: { call: ToolCall; args: Record<string, unknown>; adapterUsed: boolean } | undefined;
  let finishOutcome: string | undefined;
  let checkpointAttempted = false;
  const tools = new Map(input.tools.map(tool => [tool.name, tool]));
  const controlNames = new Set(['finish_task', 'read_session_history', 'read_result_artifact', 'reconcile_operation']);
  const fatal = (): never => { throw new AssistantExecutionBoundaryError(); };
  // Once a persistence/ownership boundary fails, this instance cannot dispatch again.
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (poisoned) return fatal();
    try { return await fn(); } catch {
      poisoned = true;
      session = structuredClone(confirmedSession);
      return fatal();
    }
  };
  const active = async () => {
    input.signal.throwIfAborted();
    await input.assertActive();
    await input.store.assertOwner(session.id, input.run.siteId, input.owner, 180);
  };
  const key = (phase: string, index: number, id = '') => `requirement-assistant:${createHash('sha256')
    .update(JSON.stringify([session.id, phase, index, id])).digest('hex')}`;
  const log = async (event: LogEvent) => { await active(); await input.writeLog(redactData(event, input.redact)); };
  const save = async () => {
    await active();
    const now = Date.now();
    const next = redactData({ ...session, activeMs: session.activeMs + Math.max(0, now - measuredAt),
      updatedAt: new Date(now).toISOString() }, input.redact);
    if (serializedBytes(next) > SNAPSHOT_MAX_BYTES) return fatal();
    session = structuredClone(await input.store.save(next, input.run.siteId, input.owner));
    confirmedSession = structuredClone(session);
    measuredAt = now;
  };
  const outstanding = () => {
    const receipts = new Set(session.messages.filter(message => message.role === 'tool').map(message => message.toolCallId));
    return session.messages.flatMap(message => message.toolCalls || []).filter(call => !receipts.has(call.id));
  };
  const pause = async (reason: string): Promise<never> => {
    session.status = 'paused'; session.reason = reason; await save(); return fatal();
  };
  const ready = async () => {
    if (!initialized || session.status !== 'running') return fatal();
    await active();
    if (session.activeMs + Math.max(0, Date.now() - measuredAt) >= session.request.limits.maxActiveMs) {
      await pause('active_time_budget_exhausted');
    }
  };
  const effectArgs = (args: any) => {
    const { thought_process: _thoughtProcess, ...rest } = z.record(z.unknown()).parse(args);
    return rest;
  };
  const argsFor = (call: ToolCall) => {
    const raw = effectArgs(JSON.parse(call.arguments));
    const args = tools.get(call.name)?.normalizeArguments?.(raw) ?? raw;
    if (!sameJson(args, redactData(args, input.redact))) return fatal();
    return args;
  };
  const context = (operationId: string): ToolContext => ({ sessionId: session.id, operationId,
    signal: input.signal, assertActive: () => guard(active) });
  const checkpoint = async () => {
    if (!input.onCheckpoint || checkpointAttempted || session.pending || outstanding().length) return;
    checkpointAttempted = true;
    await active();
    // Infrastructure backup is best effort, but ownership loss remains fatal.
    try { await input.onCheckpoint({ owner: input.owner, assertActive: () => guard(active), signal: input.signal }); }
    catch { if (poisoned) return fatal(); }
    await active();
  };

  const recoverCanonicalCalls = async () => {
    const pending = session.pending;
    const calls = outstanding();
    // A pending checkpoint without its original batch is corrupt, not permission
    // to invent a batch or dispatch an operation.
    if (pending && !session.messages.some(message => message.toolCalls?.some(call => sameJson(call, pending.call)))) return fatal();
    if (pending?.effect === 'write') {
      for (const identity of [pending.fingerprint, requirementOperationFingerprint(pending.call.name, argsFor(pending.call))]) {
        if (!session.uncertainOperations.includes(identity)) session.uncertainOperations.push(identity);
      }
      await save(); // Fence survives even if artifact/log/receipt persistence fails.
    }
    for (const call of calls) {
      await active();
      const wasPending = pending?.call.id === call.id;
      const result: ToolResult = { ok: false, error: wasPending
        ? { code: 'OPERATION_OUTCOME_UNKNOWN', message: 'Execution was interrupted after its dispatch checkpoint. Outcome is unknown; no operation was replayed.',
          ...(pending.effect === 'write' ? { ambiguous: true } : {}) }
        : { code: 'OPERATION_NOT_EXECUTED', message: 'This call was interrupted before its dispatch checkpoint and was not executed. Choose a fresh call if still needed.', effectStarted: false } };
      if (serializedBytes(session) + RECEIPT_MAX_BYTES + 4000 > SNAPSHOT_MAX_BYTES) return pause('transcript_storage_budget_exhausted');
      // Recovery must remain possible even when artifact capacity is exhausted.
      // Its bounded receipt is stored atomically in the already-reserved snapshot space.
      const receipt: Message = { role: 'tool', toolCallId: call.id,
        content: JSON.stringify(redactData(result, input.redact)) };
      const index = session.messages.findIndex(message => message.toolCalls?.some(candidate => candidate.id === call.id));
      await log({ key: key('tool-recovery', index, call.id), log_type: 'tool_result',
        message: 'Interrupted canonical call resolved without replay.', tool_name: call.name, tool_call_id: call.id,
        tool_result: JSON.parse(receipt.content), is_error: true, details: { recovery: true, dispatched_checkpoint: wasPending } });
      session.messages.push(receipt);
      if (wasPending) delete session.pending;
      session.assistantAuditCursor = session.messages.length;
      await save();
    }
    // Defensive compatibility with an already-receipted pending call: no duplicate receipt.
    if (session.pending) { delete session.pending; await save(); }
  };

  const initialize = () => guard(async () => {
    if (initialized) return;
    await active();
    if (session.id !== input.run.sessionId || session.request.requirementId !== input.run.requirementId ||
      tools.size !== input.tools.length || input.tools.some(tool => controlNames.has(tool.name))) return fatal();
    if (![session.turns, session.allocatedTokens, session.activeMs].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !Object.values(session.request.limits).every(value => Number.isSafeInteger(value) && value > 0)) return fatal();
    // Imported history is explicitly historical, not fabricated current execution evidence.
    // Bound each event and the number of imports; the complete transcript remains readable.
    const canonicalCheckpoint = session.assistantExecutionVersion === 1 ||
      (session.assistantExecutionVersion === undefined && Number.isSafeInteger(session.assistantAuditCursor) && session.assistantAuditCursor! >= 0 &&
        session.reason !== 'migration_pending_operation_requires_reconciliation');
    const cursor = Number.isSafeInteger(session.assistantAuditCursor) && session.assistantAuditCursor! >= 0
      ? Math.min(session.assistantAuditCursor!, session.messages.length) : 0;
    const offset = Math.max(cursor, session.messages.length - 100);
    if (offset > cursor) await log({ key: key('history-prefix', offset), log_type: 'system',
      message: 'Earlier session history remains available through read_session_history.',
      details: { historical_import: true, omitted_messages: offset } });
    for (let index = offset; index < session.messages.length; index++) {
      const message = session.messages[index];
      await log({ key: key('history', index, message.toolCallId || ''), log_type: 'system',
        message: input.redact(message.content).slice(0, 6000),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        details: { historical_import: true, message_index: index, role: message.role,
          tool_calls: message.toolCalls?.slice(0, 32).map(call => ({ id: input.redact(call.id).slice(0, 200), name: call.name.slice(0, 64) })) || [] } });
    }
    const migrationPending = !canonicalCheckpoint && (!!session.pending || outstanding().length > 0);
    if (migrationPending) {
      // Unlike the old engine, NEVER replay even a read or an undispatched legacy call.
      session.assistantExecutionVersion = 0; // Import cursor is NOT a canonical dispatch marker.
      if (session.pending?.effect === 'write' && !session.uncertainOperations.includes(session.pending.fingerprint)) {
        session.uncertainOperations.push(session.pending.fingerprint);
      }
      await log({ key: key('migration-pending', session.messages.length, session.pending?.call.id), log_type: 'system',
        message: 'Imported unfinished operation requires trusted reconciliation. No operation was replayed.', is_error: true });
      session.status = 'paused'; session.reason = 'migration_pending_operation_requires_reconciliation';
    }
    session.assistantAuditCursor = session.messages.length;
    if (migrationPending || cursor < session.messages.length) await save();
    initialized = true;
    // Upgrade old transport fingerprints without removing their original fences.
    let upgradedFence = false;
    for (const message of session.messages) for (const call of message.toolCalls || []) {
      if (call.name !== 'tools' || !session.uncertainOperations.length) continue;
      const args = argsFor(call);
      const oldIdentity = operationFingerprint(call.name, args);
      if (session.uncertainOperations.includes(oldIdentity)) {
        const identity = requirementOperationFingerprint(call.name, args);
        if (!session.uncertainOperations.includes(identity)) { session.uncertainOperations.push(identity); upgradedFence = true; }
      }
    }
    if (upgradedFence && session.status === 'running') await save();
    if (canonicalCheckpoint && session.status === 'running') {
      await recoverCanonicalCalls();
      // A successful finish receipt is durable intent even if the process died
      // between receipt save and afterTurn. No fresh inference is necessary.
      const last = session.messages.at(-1);
      const finishCall = last?.role === 'tool' && session.messages.flatMap(message => message.toolCalls || [])
        .find(call => call.id === last.toolCallId && call.name === 'finish_task');
      if (finishCall && !session.pending && !outstanding().length) {
        let accepted = false;
        try { accepted = JSON.parse(last!.content).ok === true; } catch { /* Not a success receipt. */ }
        if (accepted) {
          finishOutcome = finishSchema.parse(effectArgs(JSON.parse(finishCall.arguments))).outcome;
          await checkpoint();
          session.status = 'completed'; session.reason = finishOutcome;
          await save();
          finishOutcome = undefined;
        }
      }
    }
  });

  const executeHarnessTool = async (name: string, args: any): Promise<ToolResult> => {
    // Host wrappers call this ONLY inside the exact callback supplied to executeTool.
    // No ambient/reconstructed operation ID, and no second dispatch in one callback.
    if (!executing || executing.call.name !== name || executing.adapterUsed ||
      !sameJson(effectArgs(args), effectArgs(JSON.parse(executing.call.arguments)))) return fatal();
    executing.adapterUsed = true;
    await guard(active);
    const adapter = tools.get(name);
    if (!adapter) return fatal();
    return adapter.execute(executing.args, context(executing.call.id));
  };

  const executeControl = async (name: string, args: any): Promise<ToolResult> => {
    if (!executing || executing.call.name !== name || executing.adapterUsed ||
      !sameJson(effectArgs(args), effectArgs(JSON.parse(executing.call.arguments)))) return fatal();
    executing.adapterUsed = true;
    await guard(active);
    args = effectArgs(args);
    if (name === 'finish_task') {
      const finish = finishSchema.parse(args);
      if (outstanding().length !== 1) {
        return { ok: false, error: { code: 'OUTSTANDING_OPERATIONS', message: 'Finish only after outstanding operations are resolved.' } };
      }
      finishOutcome = finish.outcome;
      return { ok: true, output: finish };
    }
    if (name === 'read_session_history') {
      const page = historySchema.parse(args);
      const messages: Message[] = [];
      for (const message of session.messages.slice(page.offset, page.offset + page.limit)) {
        if (serializedBytes([...messages, message]) > 300000) break;
        messages.push(message);
      }
      return { ok: true, output: { offset: page.offset, total: session.messages.length,
        messages: messages as any, nextOffset: page.offset + messages.length < session.messages.length ? page.offset + messages.length : null } };
    }
    if (name === 'read_result_artifact') {
      const page = artifactSchema.parse(args);
      const result = await guard(() => input.artifacts.read(session.id, input.run.siteId, input.owner, page.id, page.offset, page.limit));
      return result ? { ok: true, output: result } : { ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: 'No artifact in this session.' } };
    }
    const { operationId } = reconcileSchema.parse(args);
    const original = session.messages.flatMap(message => message.toolCalls || []).find(call => call.id === operationId);
    const adapter = original && tools.get(original.name);
    if (!original || !adapter?.reconcile) return { ok: false, error: { code: 'RECONCILIATION_UNAVAILABLE',
      message: 'Trusted provider/operator reconciliation is required. Model claims do not authorize replay.' } };
    const originalArgs = argsFor(original);
    const fingerprint = requirementOperationFingerprint(original.name, originalArgs);
    const proof = await adapter.reconcile(originalArgs, context(original.id));
    await guard(active);
    if (!session.uncertainOperations.includes(fingerprint) || proof.state === 'unknown' || !proof.proof ||
      proof.proof.length > 1000 || serializedBytes(proof) > RECEIPT_MAX_BYTES) return { ok: false, output: { state: 'unknown' } };
    session.reconciledOperations ||= {};
    session.reconciledOperations[fingerprint] = { operationId, proof: input.redact(proof.proof), state: proof.state,
      ...(proof.state === 'applied' ? { result: redactData(proof.result, input.redact) } : {}) };
    return { ok: true, output: { state: proof.state } };
  };

  const controlTools = [
    { name: 'finish_task', description: 'Finish honestly after all operations return. Prose alone does not complete the task.',
      parameters: { type: 'object', properties: { summary: { type: 'string' }, outcome: { type: 'string', enum: ['implemented', 'partial', 'unable'] } }, required: ['summary', 'outcome'], additionalProperties: false } },
    { name: 'read_session_history', description: 'Read earlier durable session history by zero-based message offset.',
      parameters: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['offset'], additionalProperties: false } },
    { name: 'read_result_artifact', description: 'Read complete redacted results using artifact ID and character offsets.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8000 } }, required: ['id'], additionalProperties: false } },
    { name: 'reconcile_operation', description: 'Request trusted adapter proof for an uncertain operation. Never uses model claims as evidence.',
      parameters: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'], additionalProperties: false } },
  ].map(tool => ({ ...tool, execute: (args: any) => executeControl(tool.name, args) }));

  const boundary: AssistantExecutionBoundary & { redact: (text: string) => string } = {
    signal: input.signal,
    redact: input.redact,
    beforeModel: request => guard(async () => {
      await ready();
      if (executing || session.pending || outstanding().length || finishOutcome) return fatal();
      if (session.turns >= session.request.limits.maxTurns) return pause('turn_budget_exhausted');
      if (serializedBytes(session) > 2400000) return pause('transcript_storage_budget_exhausted');
      if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
        request.maxOutputTokens > session.request.limits.maxOutputTokens) return pause('output_token_budget_exhausted');
      const allocation = Buffer.byteLength(JSON.stringify(request)) + request.maxOutputTokens;
      if (!Number.isSafeInteger(allocation + session.allocatedTokens) || allocation + session.allocatedTokens > session.request.limits.maxTotalTokens) {
        return pause('token_budget_exhausted');
      }
      session.assistantExecutionVersion = 1;
      session.turns++; session.allocatedTokens += allocation;
      await save();
      await log({ key: key('model-start', session.messages.length, String(session.turns)), log_type: 'system',
        message: 'Canonical assistant inference allocation reserved.', details: { turn: session.turns, allocated_tokens: session.allocatedTokens } });
      await active();
      awaitingModel = true;
    }),
    onModelMessage: raw => guard(async () => {
      await ready();
      if (!awaitingModel || outstanding().length || session.pending || raw?.role !== 'assistant' || serializedBytes(raw) > 200000) return fatal();
      const calls = z.array(callSchema).max(32).parse((raw.tool_calls || []).map((call: any) => ({
        id: call.id, name: call.function?.name, arguments: call.function?.arguments })));
      const seen = new Set(session.messages.flatMap(message => message.toolCalls || []).map(call => call.id));
      for (const call of calls) {
        if (seen.has(call.id) || !sameJson(call, redactData(call, input.redact))) return fatal();
        seen.add(call.id); argsFor(call);
      }
      if (raw.reasoning_details && !sameJson(raw.reasoning_details, redactData(raw.reasoning_details, input.redact))) return fatal();
      const message: Message = { role: 'assistant', content: input.redact(typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? '')),
        ...(calls.length ? { toolCalls: calls } : {}), ...(raw.reasoning_details ? { reasoningDetails: raw.reasoning_details } : {}) };
      session.messages.push(message);
      await save();
      await log({ key: key('assistant', session.messages.length - 1), log_type: 'agent_action', message: message.content.slice(0, 6000),
        details: { message_index: session.messages.length - 1, tool_calls: calls.map(call => ({ id: call.id, name: call.name })) } });
      session.assistantAuditCursor = session.messages.length;
      await save();
      awaitingModel = false;
    }),
    executeTool: (incoming, execute) => guard(async () => {
      await ready();
      if (executing || session.pending) return fatal();
      const call = outstanding()[0];
      if (!call || incoming.id !== call.id || incoming.name !== call.name || !sameJson(incoming.args, JSON.parse(call.arguments))) return fatal();
      const args = argsFor(call);
      const effect = controlNames.has(call.name) || (call.name === 'tools' && ['list', 'describe'].includes(String(args.action)))
        ? 'read' : tools.get(call.name)?.effect ?? 'write';
      const fingerprint = requirementOperationFingerprint(call.name, args);
      const pending = { call, fingerprint, effect };
      const inlineControl = controlNames.has(call.name);
      // Controls have bounded output and use snapshot capacity, never the artifact
      // quota they are needed to inspect/recover. Reserve before invoking a control.
      const receiptBudget = !inlineControl ? RECEIPT_MAX_BYTES
        : call.name === 'read_session_history' ? 350000
        : call.name === 'finish_task' ? 180000 : 100000;
      if (serializedBytes({ ...session, pending }) + receiptBudget + 4000 > SNAPSHOT_MAX_BYTES) return pause('transcript_storage_budget_exhausted');
      if (!inlineControl) await input.artifacts.reserve(session.id, input.run.siteId, input.owner, call.id, RESULT_MAX_BYTES);
      const index = session.messages.findIndex(message => message.toolCalls?.some(candidate => candidate.id === call.id));
      await log({ key: key('tool-start', index, call.id), log_type: 'tool_call', message: 'Tool execution checkpoint.',
        tool_name: call.name, tool_call_id: call.id, tool_args: { preview: input.redact(call.arguments).slice(0, 6000) } });
      session.pending = pending;
      const resolution = session.reconciledOperations?.[fingerprint];
      if (resolution && resolution.state !== 'applied') delete session.reconciledOperations![fingerprint];
      await save();
      await active();
      let output: any;
      if (effect === 'write' && session.uncertainOperations.includes(fingerprint) && !resolution) {
        output = { ok: false, error: { code: 'RECONCILIATION_REQUIRED', ambiguous: true, message: 'Operation outcome unknown; automatic replay disabled.' } };
      } else if (resolution?.state === 'applied') {
        output = resolution.result || { ok: true, output: { reconciled: true, proof: resolution.proof } };
      } else {
        executing = { call, args, adapterUsed: false };
        try {
          output = await execute(); // Exact canonical callback: preserve its router/permission/wrapper semantics.
        } catch (error: any) {
          if (input.signal.aborted || /(?:Recovery|Ownership|SessionStore|ArtifactStore|HostStateStore|Database|Billing)Error$/.test(error?.name || '')) return fatal();
          output = { ok: false, error: { code: 'TOOL_ERROR', message: safeError(error, input.redact),
            ...(effect === 'write' && error?.effectStarted !== false ? { ambiguous: true } : { effectStarted: false }) } };
        } finally { executing = undefined; }
      }
      await active();
      // Detach wrapper results before redaction; never mutate the canonical tool's object.
      const safeOutput = redactData(JSON.parse(JSON.stringify(output ?? null)), input.redact);
      const result = requirementOperationResult(safeOutput);
      if (!result.ok && effect === 'write' && result.error?.effectStarted !== false) {
        result.error = { code: result.error?.code || 'TOOL_ERROR', message: result.error?.message || 'Tool reported failure; outcome requires reconciliation.', ...result.error, ambiguous: true };
      }
      if (result.error?.ambiguous && !session.uncertainOperations.includes(fingerprint)) session.uncertainOperations.push(fingerprint);
      const receipt: Message = inlineControl
        ? { role: 'tool', toolCallId: call.id, content: JSON.stringify(result) }
        : await persistResult({ artifacts: input.artifacts, sessionId: session.id, siteId: input.run.siteId,
          owner: input.owner, call, result, redact: input.redact });
      if (serializedBytes(receipt) > receiptBudget) return fatal();
      await log({ key: key('tool-result', index, call.id), log_type: 'tool_result', message: 'Durable tool result recorded.',
        tool_name: call.name, tool_call_id: call.id, tool_result: JSON.parse(receipt.content), is_error: !result.ok });
      session.messages.push(receipt);
      delete session.pending;
      session.assistantAuditCursor = session.messages.length;
      if (call.name === 'finish_task' && !result.ok) finishOutcome = undefined;
      await save();
      return safeOutput;
    }),
    afterTurn: _messages => guard(async () => {
      if (!initialized || executing || session.pending || outstanding().length || awaitingModel) return fatal();
      if (session.status === 'completed') return;
      // Incremental assistant batches and bounded durable receipts are authoritative.
      // Do not replace them with provider context compaction or unbounded wrapper output.
      if (finishOutcome) {
        await checkpoint();
        session.status = 'completed'; session.reason = finishOutcome;
      }
      await save();
      finishOutcome = undefined;
    }),
  };
  return { boundary, getSession: () => structuredClone(session),
    getMessages: () => redactData(session.messages.map(canonical), input.redact), initialize,
    finish: () => guard(async () => {
      await boundary.afterTurn([]);
      if (session.status === 'running') await checkpoint();
    }), controlTools, executeHarnessTool };
}