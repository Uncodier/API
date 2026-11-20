import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError } from './access';
import { ConnectorError } from './types';
import { unavailable, type ApprovalRow, type StoredAction } from './approval-action';

const timeout = () => AbortSignal.timeout(5000);
export type ProposalScope = { siteId: string; conversationId: string | null; agentId: string; idempotencyKey: string; source?: StoredAction['source'] };
export async function requestProposal(scope: ProposalScope, action: StoredAction) {
  const { data, error } = await supabaseAdmin.rpc('request_connector_action_approval', {
    p_site_id: scope.siteId, p_conversation_id: scope.conversationId, p_agent_id: scope.agentId,
    p_idempotency_key: scope.idempotencyKey, p_action: scope.source ? { ...action, source: scope.source } : action,
  }).abortSignal(timeout()).maybeSingle<ApprovalRow>();
  if (error?.code === '54000') throw new ConnectorError('APPROVAL_QUEUE_FULL', 'Too many pending approvals.', 429);
  if (error?.code === '23505') throw unavailable();
  if (error) connectorDatabaseError(error);
  if (data?.status !== 'pending' || !(Date.parse(data.expires_at) > Date.now())) throw unavailable();
  return { status: 'pending' as const };
}
const columns = 'id,site_id,conversation_id,agent_id,action,status,created_at,expires_at,actor_user_id';
const reviewLink = z.object({ review_conversation_id: z.string().uuid() }).nullable();
export async function pendingRows(siteId: string): Promise<ApprovalRow[]> {
  const { data, error } = await supabaseAdmin.from('connector_action_approvals').select(`${columns},connector_approval_review_links(review_conversation_id)`)
    .eq('site_id', siteId).eq('status', 'pending').gt('expires_at', new Date().toISOString())
    .order('created_at').order('id').limit(101).abortSignal(timeout());
  if (error || !data) connectorDatabaseError(error);
  if (data.length > 100) throw new ConnectorError('QUEUE_LIMIT', 'Approval queue exceeds the supported limit.', 503);
  // This FK is the primary key of the link table. PostgREST represents a
  // reverse one-to-one as an object (or null), not a collection.
  return data.map(raw => {
    const link = reviewLink.safeParse(raw.connector_approval_review_links);
    if (!link.success) connectorDatabaseError(null);
    return { ...raw, connector_approval_review_links: link.data } satisfies ApprovalRow;
  });
}
export async function getApproval(siteId: string, id: string) {
  const { data, error } = await supabaseAdmin.from('connector_action_approvals').select(columns)
    .eq('site_id', siteId).eq('id', id).abortSignal(timeout()).maybeSingle<ApprovalRow>();
  if (error) connectorDatabaseError(error);
  if (!data) throw new ConnectorError('NOT_FOUND', 'Approval not found.', 404);
  return data as ApprovalRow;
}
export async function decideRow(siteId: string, id: string, userId: string, decision: 'approve' | 'reject') {
  const { error, data } = await supabaseAdmin.rpc('decide_connector_action_approval', {
    p_site_id: siteId, p_approval_id: id, p_actor_user_id: userId, p_decision: decision,
  }).abortSignal(timeout()).maybeSingle<ApprovalRow>();
  if (error) connectorDatabaseError(error);
  if (!data || data.id !== id || data.site_id !== siteId || data.actor_user_id !== userId ||
    data.status !== (decision === 'approve' ? 'executing' : 'rejected')) throw unavailable();
  return data as ApprovalRow;
}
export async function finishRow(siteId: string, id: string, userId: string, status: 'succeeded' | 'failed') {
  const { error, data } = await supabaseAdmin.rpc('finish_connector_action_approval', {
    p_site_id: siteId, p_approval_id: id, p_actor_user_id: userId, p_status: status,
  }).abortSignal(timeout()).maybeSingle<ApprovalRow>();
  if (error) connectorDatabaseError(error);
  if (data?.status !== status) throw unavailable();
}
