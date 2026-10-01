import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  canonicalRecoveryJson, cloneRecoveryJson, isRecord, RecoveryError,
  type AssistantRecoveryScope,
} from './assistant-recovery-schema';

const NODE_COLUMNS = 'id,instance_id,site_id,type,parent_node_id,prompt,result,settings,status';

function checkedNode(value: unknown, id: string, scope: AssistantRecoveryScope): Record<string, unknown> {
  if (!isRecord(value) || value.id !== id || value.instance_id !== scope.instanceId ||
      value.site_id !== scope.siteId || typeof value.type !== 'string' ||
      value.status === 'stopped' || value.status === 'cancelled') {
    throw new RecoveryError('context_changed');
  }
  return value;
}

function contentSettings(value: unknown): unknown {
  if (value === null) return null;
  if (!isRecord(value)) throw new RecoveryError('context_changed');
  const { ui_position: _position, ...settings } = value;
  return settings;
}

/** Direct references only: no history reconstruction, generated child results, or UI metadata. */
export async function captureRecoveryNodeFingerprint(scope: AssistantRecoveryScope, nodeId: string): Promise<string> {
  try {
    const [targetResult, refsResult] = await Promise.all([
      supabaseAdmin.from('instance_nodes').select(NODE_COLUMNS)
        .eq('id', nodeId).eq('instance_id', scope.instanceId).eq('site_id', scope.siteId).maybeSingle(),
      // Do not filter out a foreign-site link: its presence must invalidate the snapshot.
      supabaseAdmin.from('instance_node_contexts').select('target_node_id,context_node_id,type,site_id')
        .eq('target_node_id', nodeId),
    ]);
    if (targetResult.error || refsResult.error || !Array.isArray(refsResult.data)) {
      throw new RecoveryError('context_changed');
    }
    const target = checkedNode(targetResult.data, nodeId, scope);
    const refs = refsResult.data as Record<string, unknown>[];
    if (refs.some(ref => !isRecord(ref) || ref.target_node_id !== nodeId || ref.site_id !== scope.siteId ||
      typeof ref.context_node_id !== 'string' || !ref.context_node_id || typeof ref.type !== 'string')) {
      throw new RecoveryError('context_changed');
    }
    // The executor injects the immediate parent when it is not already linked.
    // Its content is therefore part of the input even without a context-link row.
    if (target.parent_node_id !== null) {
      if (typeof target.parent_node_id !== 'string' || !target.parent_node_id) throw new RecoveryError('context_changed');
      if (!refs.some(ref => ref.context_node_id === target.parent_node_id)) {
        refs.push({ context_node_id: target.parent_node_id, type: 'parent_reference' });
      }
    }
    const ids = Array.from(new Set(refs.map(ref => ref.context_node_id as string)));
    let nodes: Record<string, unknown>[] = [];
    if (ids.length) {
      const result = await supabaseAdmin.from('instance_nodes').select(NODE_COLUMNS)
        .in('id', ids).eq('instance_id', scope.instanceId).eq('site_id', scope.siteId);
      if (result.error || !Array.isArray(result.data) || result.data.length !== ids.length) {
        throw new RecoveryError('context_changed');
      }
      nodes = result.data;
    }
    const linked = refs.map(ref => {
      const id = ref.context_node_id as string;
      const node = checkedNode(nodes.find(candidate => candidate.id === id), id, scope);
      return {
        referenceType: ref.type, id, type: node.type, prompt: node.prompt,
        result: node.result, settings: contentSettings(node.settings),
      };
    }).sort((left, right) => canonicalRecoveryJson(left).localeCompare(canonicalRecoveryJson(right)));
    const snapshot = cloneRecoveryJson({
      target: {
        id: target.id, type: target.type, parent: target.parent_node_id,
        prompt: target.prompt, settings: contentSettings(target.settings),
      },
      linked,
    }, 2 * 1024 * 1024);
    return createHash('sha256').update(canonicalRecoveryJson(snapshot)).digest('hex');
  } catch {
    throw new RecoveryError('context_changed');
  }
}