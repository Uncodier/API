import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getRedisClient } from '@/lib/utils/redis-client';
import {
  type NodeResult,
  buildInitialNodeResult,
} from './node-result-collector';

const LIVE_STREAM_TTL_SECONDS = 15 * 60;
const DEFAULT_DB_CHECKPOINT_MS = 2_000;
const lastCheckpointAt = new Map<string, number>();

type StreamKind = 'log' | 'node';

export interface LiveStreamSnapshot {
  id: string;
  instance_id: string;
  kind: StreamKind;
  log_type?: 'agent_action' | 'thinking';
  level?: 'info';
  message: string;
  created_at: string;
  updated_at: string;
  details?: Record<string, unknown>;
}

function isRedisConfigured(): boolean {
  return Boolean(
    process.env.REDIS_CACHE_URL?.trim() || process.env.REDIS_URL?.trim(),
  );
}

function instanceStreamKey(instanceId: string): string {
  return `live:ai-stream:instance:${instanceId}`;
}

function checkpointIntervalMs(): number {
  const value = Number(process.env.AI_STREAM_DB_CHECKPOINT_MS);
  return Number.isFinite(value) && value >= 250
    ? value
    : DEFAULT_DB_CHECKPOINT_MS;
}

function shouldCheckpoint(id: string, final: boolean): boolean {
  if (final) return true;
  const now = Date.now();
  const previous = lastCheckpointAt.get(id) ?? 0;
  if (now - previous < checkpointIntervalMs()) return false;
  lastCheckpointAt.set(id, now);
  return true;
}

async function writeSnapshot(snapshot: LiveStreamSnapshot): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  try {
    const redis = getRedisClient();
    const key = instanceStreamKey(snapshot.instance_id);
    await redis
      .multi()
      .hset(key, `${snapshot.kind}:${snapshot.id}`, JSON.stringify(snapshot))
      .expire(key, LIVE_STREAM_TTL_SECONDS)
      .exec();
    return true;
  } catch (error) {
    console.warn(
      '[AI Stream] Redis snapshot failed:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function removeSnapshot(
  instanceId: string,
  kind: StreamKind,
  id: string,
): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    await getRedisClient().hdel(instanceStreamKey(instanceId), `${kind}:${id}`);
  } catch (error) {
    console.warn(
      '[AI Stream] Redis cleanup failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

export async function readLiveInstanceLogSnapshots(
  instanceId: string,
): Promise<LiveStreamSnapshot[]> {
  if (!isRedisConfigured()) return [];
  try {
    const values = await getRedisClient().hvals(instanceStreamKey(instanceId));
    return values.flatMap((value) => {
      try {
        const snapshot = JSON.parse(value) as LiveStreamSnapshot;
        return snapshot.kind === 'log' ? [snapshot] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    console.warn(
      '[AI Stream] Redis read failed:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

async function persistLogChunk(params: {
  id: string;
  instanceId: string;
  text: string;
  logType: 'agent_action' | 'thinking';
  details: Record<string, unknown>;
  createdAt: string;
  final?: boolean;
}): Promise<void> {
  const final = params.final === true;
  const snapshotStored = await writeSnapshot({
    id: params.id,
    instance_id: params.instanceId,
    kind: 'log',
    log_type: params.logType,
    level: 'info',
    message: params.text,
    created_at: params.createdAt,
    updated_at: new Date().toISOString(),
    details: params.details,
  });

  let persisted = false;
  if (shouldCheckpoint(params.id, final) || !snapshotStored) {
    const attempts = final ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const { error } = await supabaseAdmin
        .from('instance_logs')
        .update(final ? { message: params.text, details: { ...params.details, streaming: false } }
          : { message: params.text })
        .eq('id', params.id);
      if (!error) {
        persisted = true;
        break;
      }
      console.error('[AI Stream] Log checkpoint failed:', error);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
  }

  if (final && persisted) {
    lastCheckpointAt.delete(params.id);
    await removeSnapshot(params.instanceId, 'log', params.id);
  }
}

async function updateParentLogStatus(
  parentLogId: string | undefined,
  status: 'completed' | 'failed',
): Promise<void> {
  if (!parentLogId) return;
  const { data } = await supabaseAdmin
    .from('instance_logs')
    .select('details')
    .eq('id', parentLogId)
    .single();
  if (!data) return;
  await supabaseAdmin
    .from('instance_logs')
    .update({ details: { ...((data.details as object) || {}), status } })
    .eq('id', parentLogId);
}

export function createStreamingLogCallbacks(
  instanceId: string,
  siteId: string,
  userId: string | undefined,
  provider: string,
  planId?: string,
  stepId?: string,
  requirementId?: string,
) {
  const details = {
    provider,
    response_type: 'assistant_step',
    streaming: true,
    ...(planId ? { plan_id: planId } : {}),
    ...(stepId ? { step_id: stepId } : {}),
    ...(requirementId ? { requirement_id: requirementId } : {}),
  };
  const createdAtById = new Map<string, string>();
  return {
    onStreamStart: async (): Promise<string> => {
      const { data, error } = await supabaseAdmin
        .from('instance_logs')
        .insert({
          log_type: 'agent_action',
          level: 'info',
          message: '',
          details,
          instance_id: instanceId,
          site_id: siteId,
          user_id: userId,
        })
        .select('id')
        .single();
      if (error) throw new Error(`Failed to create streaming log: ${error.message}`);
      createdAtById.set(data.id, new Date().toISOString());
      return data.id;
    },
    onStreamChunk: (
      logId: string,
      text: string,
      final = false,
    ): Promise<void> => persistLogChunk({
      id: logId,
      instanceId,
      text,
      logType: 'agent_action',
      details,
      createdAt: createdAtById.get(logId) || new Date().toISOString(),
      final,
    }).finally(() => {
      if (final) createdAtById.delete(logId);
    }),
  };
}

export interface NodeContextRef {
  context_node_id: string;
  type: string;
}

export function createNodeStreamingCallbacks(
  promptNodeId: string,
  promptNode: any,
  contextRefs?: NodeContextRef[],
) {
  const initialResult = buildInitialNodeResult(promptNode);
  return {
    onNodeStreamStart: async (): Promise<string> => {
      const { data, error } = await supabaseAdmin
        .from('instance_nodes')
        .insert({
          instance_id: promptNode.instance_id,
          parent_node_id: promptNodeId,
          parent_instance_log_id: promptNode.parent_instance_log_id,
          type: 'response',
          prompt: promptNode.prompt,
          settings: promptNode.settings || {},
          status: 'running',
          result: initialResult,
          site_id: promptNode.site_id,
          user_id: promptNode.user_id,
        })
        .select('id')
        .single();
      if (error) throw new Error(`Failed to create response node: ${error.message}`);

      if (contextRefs?.length) {
        const rows = contextRefs.map((ref) => ({
          target_node_id: data.id,
          context_node_id: ref.context_node_id,
          type: ref.type,
          site_id: promptNode.site_id,
          user_id: promptNode.user_id,
        }));
        const { error: contextError } = await supabaseAdmin
          .from('instance_node_contexts')
          .insert(rows);
        if (contextError) {
          console.error('[Node Executor] Error inserting context refs:', contextError);
        }
      }
      return data.id;
    },
    onNodeStreamChunk: async (
      nodeId: string,
      text: string,
      final = false,
    ): Promise<void> => {
      const result: NodeResult = { text, status: 'streaming' };
      if (initialResult.outputs) result.outputs = initialResult.outputs;
      let persisted = false;
      if (shouldCheckpoint(nodeId, final)) {
        const { error } = await supabaseAdmin
          .from('instance_nodes')
          .update({ result, updated_at: new Date().toISOString() })
          .eq('id', nodeId);
        if (error) console.error('[Node Executor] Stream checkpoint failed:', error);
        else persisted = true;
      }
      if (final && persisted) {
        lastCheckpointAt.delete(nodeId);
        await removeSnapshot(promptNode.instance_id, 'node', nodeId);
      }
    },
    onNodeStreamEnd: async (nodeId: string, result: NodeResult): Promise<void> => {
      const { error } = await supabaseAdmin
        .from('instance_nodes')
        .update({
          status: 'completed',
          result,
          updated_at: new Date().toISOString(),
        })
        .eq('id', nodeId);
      if (error) console.error('[Node Executor] Final update failed:', error);
      if (!error) {
        await updateParentLogStatus(
          promptNode.parent_instance_log_id,
          'completed',
        );
        lastCheckpointAt.delete(nodeId);
        await removeSnapshot(promptNode.instance_id, 'node', nodeId);
      }
    },
    onNodeStreamError: async (
      nodeId: string | null,
      errorMessage: string,
    ): Promise<void> => {
      if (!nodeId) return;
      const { error } = await supabaseAdmin
        .from('instance_nodes')
        .update({
          status: 'failed',
          error_message: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', nodeId);
      if (!error) {
        await updateParentLogStatus(promptNode.parent_instance_log_id, 'failed');
        lastCheckpointAt.delete(nodeId);
        await removeSnapshot(promptNode.instance_id, 'node', nodeId);
      }
    },
  };
}

export function createThinkingStreamLogCallbacks(
  instanceId: string,
  siteId: string,
  userId: string | undefined,
  provider: string,
  planId?: string,
  stepId?: string,
  requirementId?: string,
) {
  const details = {
    provider,
    response_type: 'reasoning',
    streaming: true,
    ...(planId ? { plan_id: planId } : {}),
    ...(stepId ? { step_id: stepId } : {}),
    ...(requirementId ? { requirement_id: requirementId } : {}),
  };
  const createdAtById = new Map<string, string>();
  return {
    onThinkingStreamStart: async (): Promise<string> => {
      const { data, error } = await supabaseAdmin
        .from('instance_logs')
        .insert({
          log_type: 'thinking',
          level: 'info',
          message: '',
          details,
          instance_id: instanceId,
          site_id: siteId,
          user_id: userId,
        })
        .select('id')
        .single();
      if (error) throw new Error(`Failed to create thinking log: ${error.message}`);
      createdAtById.set(data.id, new Date().toISOString());
      return data.id;
    },
    onThinkingStreamChunk: (
      logId: string,
      text: string,
      final = false,
    ): Promise<void> => persistLogChunk({
      id: logId,
      instanceId,
      text,
      logType: 'thinking',
      details,
      createdAt: createdAtById.get(logId) || new Date().toISOString(),
      final,
    }).finally(() => {
      if (final) createdAtById.delete(logId);
    }),
    onReasoningTokensUsed: async (reasoningTokensCount: number): Promise<void> => {
      const { error } = await supabaseAdmin.from('instance_logs').insert({
        log_type: 'thinking',
        level: 'info',
        message: `Model used ${reasoningTokensCount} reasoning tokens.`,
        details: {
          ...details,
          response_type: 'reasoning_tokens_fallback',
          streaming: false,
          reasoning_tokens: reasoningTokensCount,
        },
        instance_id: instanceId,
        site_id: siteId,
        user_id: userId,
      });
      if (error) console.error('[AI Stream] Reasoning fallback failed:', error);
    },
  };
}
