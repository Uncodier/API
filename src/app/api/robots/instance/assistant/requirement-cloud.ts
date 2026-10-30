import { randomUUID, createHash } from 'node:crypto';
import { createSession } from '@/lib/harness/session';
import { createSessionStore } from '@/lib/harness/store';
import { createArtifactStore } from '@/lib/harness/artifact-store';
import { createRequirementTools } from '@/lib/harness/requirement-tools';
import { createCloudFileTools } from '@/lib/cloud-files/tools';
import { createCloudFileStore } from '@/lib/cloud-files/store';
import { createRedactor } from '@/lib/harness/security';
import type { RequirementRun } from '@/lib/harness/requirement-types';
import type { HarnessTool } from '@/lib/harness/types';
import { runRequirementAssistantSlice } from './requirement-session';
import { writeRequirementInstanceLog } from './requirement-instance-log';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';

/** Canonical session/turn executor with no workspace, Git checkout or VM lease. */
export async function runCloudRequirementCycle(run: RequirementRun, objective: string,
  assertActive: () => Promise<void>, getContext: () => Promise<string>) {
  const store = createSessionStore();
  await assertActive();
  let session = await store.load(run.sessionId, run.siteId);
  if (!session) {
    const initial = createSession({ objective: objective.slice(0, 24000), executionEnvironment: 'cloud',
      limits: { maxTurns: 100, maxOutputTokens: 4096, maxTotalTokens: 1000000, maxActiveMs: 3600000 } }, run.sessionId);
    initial.request.requirementId = run.requirementId;
    initial.request.cloudInstanceId = run.instanceId;
    await store.create(initial, { siteId: run.siteId, userId: run.userId });
  } else if (session.request.executionEnvironment !== 'cloud' || session.request.requirementId !== run.requirementId ||
      session.request.cloudInstanceId !== run.instanceId || session.workspace) {
    throw new Error('Requirement environment changed; existing execution requires reconciliation');
  }
  const owner = randomUUID();
  session = await store.claim(run.sessionId, run.siteId, owner, 300);
  if (!session) return { status: 'not_claimed', session: await store.load(run.sessionId, run.siteId) };
  const signal = AbortSignal.timeout(210000);
  const active = async () => { signal.throwIfAborted(); await assertActive(); await store.assertOwner(run.sessionId, run.siteId, owner, 300); };
  const scope = { siteId: run.siteId, userId: run.userId, instanceId: run.instanceId, requirementId: run.requirementId };
  const descriptors = createCloudFileTools(scope, active, { allowRequirementWrite: true });
  const operationIdentity = (callId: string) => {
    const hex = createHash('sha256').update(`${run.sessionId}:${callId}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const cloudTools: HarnessTool[] = descriptors.map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    effect: tool.name === 'write_cloud_file' ? 'write' : 'read',
    execute: async (args, context) => {
      // Durable tool-call identity, never a model argument. Retries retain it.
      const operationId = operationIdentity(context.operationId);
      const result = await createCloudFileTools(scope, active, { operationId: () => operationId, allowRequirementWrite: true })
        .find(candidate => candidate.name === tool.name)!.execute(args as any);
      return JSON.parse(JSON.stringify(result));
    },
    ...(tool.name === 'write_cloud_file' ? { reconcile: async (_args: Record<string, unknown>, context: { operationId: string }) => {
      await active();
      await assertToolScreenAccess('read_cloud_file', scope);
      const operationId = operationIdentity(context.operationId);
      const result = await createCloudFileStore().readOperation(scope, operationId);
      await active();
      await assertToolScreenAccess('read_cloud_file', scope);
      if (!result) return { state: 'unknown' as const };
      // The atomic journal proves precisely this committed operation. Omit full
      // content from the recovery receipt; read_cloud_file supplies bounded pages.
      const { content: _content, ...receipt } = result;
      return { state: 'applied' as const, proof: `cloud-operation:${operationId}`, result: {
        ok: result.state !== 'conflict', output: JSON.parse(JSON.stringify(receipt)),
        ...(result.state === 'conflict' ? { error: { code: 'conflict', message: 'Version conflict; no write applied.', effectStarted: false } } : {}),
      } };
    } } : {}),
  }));
  try {
    const result = await runRequirementAssistantSlice({ session, store, owner, run, tools: [
      ...cloudTools, ...await createRequirementTools({ run }),
    ], artifacts: createArtifactStore(), redact: createRedactor(), signal, assertExecution: active, getContext });
    if (result.status === 'completed') {
      // Git availability must not keep a completed model execution running. The
      // durable publication queue retries independently and UI receipts retain status.
      let evidence = 'Cloud document work completed; Git evidence status unavailable.';
      try {
        const pending = await createCloudFileStore().listPendingGit(scope, { limit: 1 });
        evidence = pending.files.length
          ? 'Cloud document work completed and saved; Git evidence pending. Publication retries do not restart the agent.'
          : 'Cloud document work completed; no pending Git revisions were found. Use file receipts for exact delivered versions.';
      } catch { /* Completion is not undone by evidence lookup failure. */ }
      await writeRequirementInstanceLog(run, { key: `cloud-delivery:${run.runId}`, log_type: 'agent_action', message: evidence });
    }
    return { status: result.status, session: result };
  } catch (error) {
    const current = await store.load(run.sessionId, run.siteId);
    if (current?.status === 'running') {
      const uncertain = current.pending || current.uncertainOperations.length > 0 ||
        (error instanceof Error && /Recovery|Billing/.test(error.name));
      current.status = uncertain ? 'paused' : 'waiting';
      current.reason = uncertain ? 'assistant_execution_requires_reconciliation' : 'cloud_runtime_unavailable';
      await store.save(current, run.siteId, owner);
    }
    await writeRequirementInstanceLog(run, { key: `cloud-cycle-error:${run.runId}`, log_type: 'error', is_error: true,
      message: 'Cloud requirement cycle stopped. Saved revisions remain available; no workspace was started.' });
    return { status: current?.status ?? 'waiting', session: current };
  } finally {
    await store.release(run.sessionId, run.siteId, owner);
  }
}