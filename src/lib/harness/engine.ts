import { z } from 'zod';
import { buildHarnessPrompt } from './prompt';
import { withinDeadline } from './deadline';
import { createRedactor, operationFingerprint, redactData, safeError } from './security';
import { createMemoryArtifactStore } from './artifact-store';
import { persistResult, RESULT_MAX_BYTES, RECEIPT_MAX_BYTES, serializedBytes, SNAPSHOT_MAX_BYTES } from './engine-results';
import type { ArtifactStore, HarnessModel, HarnessSession, HarnessTool, Message, SessionStore, ToolCall, ToolResult, Workspace } from './types';

const MAX_CONTEXT_CHARS = 80000;
const finishSchema = z.object({ summary: z.string().min(1).max(24000),
  outcome: z.enum(['implemented', 'partial', 'unable']) }).strict();
const waitSchema = z.object({ reason: z.string().min(1).max(4000) }).strict();
const historySchema = z.object({ offset: z.number().int().min(0), limit: z.number().int().min(1).max(10).default(5) }).strict();
const artifactSchema = z.object({ id: z.string().min(1).max(200), offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(8000).default(4000) }).strict();
const reconcileSchema = z.object({ operationId: z.string().min(1).max(200) }).strict();
const callSchema = z.object({ id: z.string().min(1).max(200), name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  arguments: z.string().max(100000) });

/** Built-ins are explicit protocol actions, not completion inferred from prose or a gate. */
function controls(): HarnessTool[] {
  const execute = async (): Promise<ToolResult> => ({ ok: true });
  return [
    { name: 'finish_task', description: 'Finish with an honest summary, including checks run and limitations. This is not a claim that every validation passed.',
      parameters: { type: 'object', properties: { summary: { type: 'string' }, outcome: { type: 'string', enum: ['implemented', 'partial', 'unable'] } }, required: ['summary', 'outcome'], additionalProperties: false }, effect: 'read', execute },
    { name: 'wait_for_input', description: 'Wait only when an indispensable decision or permission is missing. Other tools remain available on resume.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false }, effect: 'read', execute },
    { name: 'read_session_history', description: 'Read earlier complete session messages omitted from the current context. Offset is zero-based.',
      parameters: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['offset'], additionalProperties: false }, effect: 'read', execute },
    { name: 'read_result_artifact', description: 'Read a full persisted tool result in character pages. Output was redacted before persistence.', effect: 'read', execute,
      parameters: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8000 } }, required: ['id'], additionalProperties: false } },
    { name: 'reconcile_operation', description: 'Ask the trusted capability adapter to verify an uncertain operation by its original call ID. Only provider proof or documented idempotency permits retry; model claims do not.', effect: 'read', execute,
      parameters: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'], additionalProperties: false } },
  ];
}

/** Keep complete assistant/tool groups; the full transcript remains in the session store. */
export function modelContext(messages: Message[]): Message[] {
  // Resume messages can arrive while a tool was pending. Keep each assistant/tool
  // exchange adjacent for the provider while retaining canonical arrival order in storage.
  const normalized: Message[] = [];
  const emitted = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!emitted.has(message.toolCallId || '')) normalized.push(message);
      continue;
    }
    normalized.push(message);
    for (const call of message.toolCalls || []) {
      const result = messages.find(candidate => candidate.role === 'tool' && candidate.toolCallId === call.id);
      if (result) { normalized.push(result); emitted.add(call.id); }
    }
  }
  messages = normalized;
  if (JSON.stringify(messages).length <= MAX_CONTEXT_CHARS) return messages;
  let start = messages.length;
  let size = 0;
  while (start > 1 && size < MAX_CONTEXT_CHARS - 26000) {
    start--;
    size += JSON.stringify(messages[start]).length;
  }
  while (start < messages.length && messages[start].role === 'tool') start++;
  return [messages[0], { role: 'user', content:
    `Context window shortened. Messages 1..${start - 1} remain available via read_session_history. Do not assume prior tools failed or repeat external operations without checking their outcomes.` }, ...messages.slice(start)];
}

function outstanding(session: HarnessSession): ToolCall[] {
  const answered = new Set(session.messages.filter(message => message.role === 'tool').map(message => message.toolCallId));
  return session.messages.flatMap(message => message.toolCalls || []).filter(call => !answered.has(call.id));
}

export interface RunSliceInput {
  session: HarnessSession;
  siteId: string;
  owner: string;
  store: SessionStore;
  model: HarnessModel;
  workspace: Workspace;
  tools: HarnessTool[];
  redact?: (text: string) => string;
  sliceMs?: number;
  now?: () => number;
  signal?: AbortSignal;
  artifacts?: ArtifactStore;
  /** Fresh product context is advisory input, not a gate or a replacement for the transcript. */
  context?: string;
  assertExecution?: () => Promise<void>;
}

/** One continuous conversation, checkpointed at each effect boundary. No product gates. */
export async function runSessionSlice(input: RunSliceInput): Promise<HarnessSession> {
  let session = structuredClone(input.session);
  const now = input.now || Date.now;
  const started = now();
  let measuredAt = started;
  const sliceMs = input.sliceMs ?? 100000;
  const redact = input.redact || createRedactor();
  const artifacts = input.artifacts || createMemoryArtifactStore(input.store);
  const tools = [...input.tools, ...controls()];
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate harness tool name');
  const system = buildHarnessPrompt(input.workspace.ref);
  const assertActive = async () => {
    if (input.signal?.aborted) throw new Error('Execution cancelled');
    await input.assertExecution?.();
    await input.store.assertOwner(session.id, input.siteId, input.owner, 180);
  };
  const save = async () => {
    const time = now();
    session.activeMs += Math.max(0, time - measuredAt);
    measuredAt = time;
    session.updatedAt = new Date(time).toISOString();
    session = await input.store.save(session, input.siteId, input.owner);
  };
  const signal = () => AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(Math.max(1,
    Math.min(90000, session.request.limits.maxActiveMs - session.activeMs - (now() - measuredAt))))]);
  const record = async (call: ToolCall, result: ToolResult) => {
    session.messages.push(await persistResult({ artifacts, sessionId: session.id, siteId: input.siteId,
      owner: input.owner, call, result, redact }));
    delete session.pending;
    await save();
  };

  await assertActive();
  session.workspace = input.workspace.ref;
  await save();
  // Crash after a write dispatch is ambiguous, not authorization to replay it.
  if (session.pending?.effect === 'write') {
    const pending = session.pending;
    if (!session.uncertainOperations.includes(pending.fingerprint)) session.uncertainOperations.push(pending.fingerprint);
    await record(pending.call, { ok: false, error: { code: 'OPERATION_OUTCOME_UNKNOWN', ambiguous: true,
      message: 'Execution was interrupted. Inspect actual files/remote receipts before retrying; this exact operation will not be replayed automatically.' } });
  }

  while (session.status === 'running') {
    await assertActive();
    if (now() - started >= sliceMs) return session;
    if (session.activeMs + now() - measuredAt >= session.request.limits.maxActiveMs) {
      session.status = 'paused'; session.reason = 'active_time_budget_exhausted'; await save(); return session;
    }
    const calls = outstanding(session);
    if (calls.length) {
      const call = calls[0];
      const tool = tools.find(candidate => candidate.name === call.name);
      let args: Record<string, unknown>;
      try {
        args = z.record(z.unknown()).parse(JSON.parse(call.arguments));
      } catch {
        await record(call, { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Arguments must be a JSON object matching the tool schema.' } });
        continue;
      }
      if (!tool) {
        await record(call, { ok: false, error: { code: 'TOOL_UNAVAILABLE', message: 'This capability is not enabled. Use available tools or request the required permission.' } });
        continue;
      }
      const fingerprint = operationFingerprint(call.name, args);
      const resolution = session.reconciledOperations?.[fingerprint];
      if (tool.effect === 'write' && session.uncertainOperations.includes(fingerprint) && !resolution) {
        await record(call, { ok: false, error: { code: 'RECONCILIATION_REQUIRED', ambiguous: true,
          message: 'The same operation has an unknown outcome. Inspect it before choosing another action; automatic replay is disabled.' } });
        continue;
      }
      if (resolution?.state === 'applied') {
        await record(call, resolution.result || { ok: true, output: { reconciled: true, proof: resolution.proof } });
        continue;
      }
      // Bound the actual encoded snapshot and reserve artifact quota BEFORE dispatch,
      // per effect rather than assuming a whole tool batch will fit.
      if (serializedBytes({ ...session, pending: { call, fingerprint, effect: tool.effect } }) + RECEIPT_MAX_BYTES + 4000 > SNAPSHOT_MAX_BYTES) {
        session.status = 'paused'; session.reason = 'transcript_storage_budget_exhausted'; await save(); return session;
      }
      try { await artifacts.reserve(session.id, input.siteId, input.owner, call.id, RESULT_MAX_BYTES); }
      catch { session.status = 'paused'; session.reason = 'result_storage_unavailable'; await save(); return session; }
      if (resolution) delete session.reconciledOperations![fingerprint]; // one proof authorizes one fresh attempt
      session.pending = { call, fingerprint, effect: tool.effect };
      await save(); // Must succeed BEFORE any effect.
      await assertActive();
      let result: ToolResult;
      try {
        if (call.name === 'finish_task') {
          const finish = finishSchema.parse(args);
          if (calls.length !== 1) throw new Error('Finish only after all other tool calls have returned.');
          session.status = 'completed'; session.reason = finish.outcome;
          result = { ok: true, output: { summary: redact(finish.summary), outcome: finish.outcome } };
        } else if (call.name === 'wait_for_input') {
          const wait = waitSchema.parse(args);
          if (calls.length !== 1) throw new Error('Wait only after all other tool calls have returned.');
          session.status = 'waiting'; session.reason = redact(wait.reason);
          result = { ok: true, output: { reason: session.reason } };
        } else if (call.name === 'read_session_history') {
          const page = historySchema.parse(args);
          result = { ok: true, output: JSON.stringify({ total: session.messages.length, offset: page.offset,
            messages: session.messages.slice(page.offset, page.offset + page.limit) }) };
        } else if (call.name === 'read_result_artifact') {
          const page = artifactSchema.parse(args);
          const artifact = await artifacts.read(session.id, input.siteId, input.owner, page.id, page.offset, page.limit);
          result = artifact ? { ok: true, output: artifact } : { ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: 'No result artifact in this session.' } };
        } else if (call.name === 'reconcile_operation') {
          const { operationId } = reconcileSchema.parse(args);
          const original = session.messages.flatMap(message => message.toolCalls || []).find(candidate => candidate.id === operationId);
          const adapter = original && tools.find(candidate => candidate.name === original.name);
          if (!original || !adapter?.reconcile) result = { ok: false, error: { code: 'RECONCILIATION_UNAVAILABLE', message: 'This operation needs provider/operator reconciliation; no automatic replay authorized.' } };
          else {
            const originalArgs = z.record(z.unknown()).parse(JSON.parse(original.arguments));
            const identity = operationFingerprint(original.name, originalArgs);
            const scopedSignal = signal();
            const verified = await withinDeadline(scopedSignal, () => adapter.reconcile!(originalArgs, {
              sessionId: session.id, operationId, signal: scopedSignal,
              assertActive: async () => { scopedSignal.throwIfAborted(); await assertActive(); },
            }));
            if (session.uncertainOperations.includes(identity) && verified.state !== 'unknown' && verified.proof &&
              verified.proof.length <= 1000 && serializedBytes(verified) <= RECEIPT_MAX_BYTES) {
              session.reconciledOperations ||= {};
              session.reconciledOperations[identity] = { operationId, proof: redact(verified.proof), state: verified.state,
                ...(verified.state === 'applied' ? { result: redactData(verified.result, redact) } : {}) };
            }
            const accepted = !!session.reconciledOperations?.[identity];
            result = { ok: accepted, output: { state: accepted ? verified.state : 'unknown' } };
          }
        } else {
          const toolSignal = signal();
          result = await withinDeadline(toolSignal, () => tool.execute(args, {
            sessionId: session.id, operationId: call.id, signal: toolSignal,
            assertActive: async () => { toolSignal.throwIfAborted(); await assertActive(); },
          }));
        }
      } catch (error) {
        const beforeEffect = error && typeof error === 'object' && 'effectStarted' in error && error.effectStarted === false;
        const ambiguous = tool.effect === 'write' && !beforeEffect;
        result = { ok: false, error: { code: 'TOOL_ERROR', message: safeError(error, redact), ...(ambiguous ? { ambiguous } : {}) } };
      }
      if (result.error?.ambiguous && !session.uncertainOperations.includes(fingerprint)) session.uncertainOperations.push(fingerprint);
      // Persistence errors deliberately escape: NEVER rerun a tool because its receipt could not be saved.
      await record(call, result);
      continue;
    }
    if (session.turns >= session.request.limits.maxTurns) {
      session.status = 'paused'; session.reason = 'turn_budget_exhausted'; await save(); return session;
    }
    // Leave space for a complete bounded tool batch and its receipts. Never discover
    // storage exhaustion only AFTER executing a side effect.
    if (Buffer.byteLength(JSON.stringify(session)) > 2400000) {
      session.status = 'paused'; session.reason = 'transcript_storage_budget_exhausted'; await save(); return session;
    }
    const messages = [...modelContext(session.messages)];
    if (input.context) messages.push({ role: 'user', content: input.context });
    // UTF-8 byte count is a conservative upper bound, not optimistic character/4 accounting.
    const reserved = Buffer.byteLength(JSON.stringify({ system, messages, tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }))
      + session.request.limits.maxOutputTokens;
    if (session.allocatedTokens + reserved > session.request.limits.maxTotalTokens) {
      session.status = 'paused'; session.reason = 'token_budget_exhausted'; await save(); return session;
    }
    session.turns++; session.allocatedTokens += reserved;
    await save();
    await assertActive();
    let reply;
    try {
      const modelSignal = signal();
      reply = await withinDeadline(modelSignal, () => input.model.respond({ system, messages, tools,
        maxOutputTokens: session.request.limits.maxOutputTokens, signal: modelSignal }));
    } catch (error) {
      session.status = 'waiting'; session.reason = `model_unavailable: ${safeError(error, redact)}`;
      await save(); return session;
    }
    await assertActive();
    if (Buffer.byteLength(JSON.stringify(reply.message)) > 200000) {
      session.status = 'waiting'; session.reason = 'model_response_too_large'; await save(); return session;
    }
    if (reply.usage && Number.isSafeInteger(reply.usage.inputTokens) && reply.usage.inputTokens >= 0 &&
      Number.isSafeInteger(reply.usage.outputTokens) && reply.usage.outputTokens >= 0) {
      session.allocatedTokens += Math.max(0, reply.usage.inputTokens + reply.usage.outputTokens - reserved);
    }
    const seenIds = new Set(session.messages.flatMap(message => message.toolCalls || []).map(call => call.id));
    const parsed = z.array(callSchema).max(32).safeParse(reply.message.toolCalls || []);
    if (!parsed.success || parsed.data.some(call => seenIds.has(call.id)) ||
      new Set(parsed.data?.map(call => call.id)).size !== parsed.data?.length) {
      session.messages.push({ role: 'user', content: 'The model returned invalid or duplicate tool identities. No tools executed. Return fresh valid calls.' });
      await save(); continue;
    }
    const rawMessage = { ...reply.message, role: 'assistant' as const };
    const encoded = JSON.stringify(rawMessage);
    const cleaned = JSON.stringify(redactData(rawMessage, redact));
    if (cleaned !== encoded) {
      // Redaction must not silently rewrite executable arguments or encrypted provider state.
      session.messages.push({ role: 'assistant', content: redact(rawMessage.content) },
        { role: 'user', content: 'Sensitive material was removed from the proposed response. No tools executed. Do not include credentials in arguments.' });
    } else if (reply.finishReason === 'length') {
      session.messages.push({ role: 'assistant', content: rawMessage.content },
        { role: 'user', content: 'Output limit reached. No partial tool calls executed. Continue with smaller actions.' });
    } else {
      session.messages.push(rawMessage);
      if (!rawMessage.toolCalls?.length) session.messages.push({ role: 'user', content:
        'Continue using tools if work remains. If finished, call finish_task with the actual result and validation limitations.' });
    }
    await save();
  }
  return session;
}