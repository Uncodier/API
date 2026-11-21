import { ChannelMessageReconciliationError, type ChannelOutcome } from './channel-message-reconciliation-error';
import { readSavedChannelOutcome } from './saved-channel-outcome';
import { channelMessageWorkflowId } from './message-identity';
import { WorkflowService, type WorkflowExecutionResponse } from '@/lib/services/workflow-service';
import type { SupportAttachment } from '@/lib/services/customer-support-attachments';

/** Server-side handoff after provider authentication, connection resolution and
 * license admission. Deliberately no caller-supplied agent, user role or tools. */
export interface VerifiedChannelMessage {
  siteId: string;
  userId?: string;
  channel: string;
  connectionId: string;
  originMessageId: string;
  message: string;
  name?: string;
  email?: string;
  phone?: string;
  source: { provider: 'zavu'; senderId: string; from: string };
  attachments: SupportAttachment[];
}

function operationId(input: VerifiedChannelMessage) {
  return channelMessageWorkflowId(input.source.provider,input.siteId,input.channel,input.connectionId,input.originMessageId);
}

async function resolveOriginal(input: VerifiedChannelMessage, execution: WorkflowExecutionResponse | undefined) {
  const workflowId = operationId(input);
  const observed = execution?.workflowId === workflowId && execution.status === 'completed'
    ? execution.data?.data?.deliveryOutcome : undefined;
  let saved: Awaited<ReturnType<typeof readSavedChannelOutcome>>;
  try { saved = await readSavedChannelOutcome(input); }
  catch { throw new ChannelMessageReconciliationError({workflowId,state:'unknown',stage:'delivery',reason:'receipt_store_unavailable'}); }
  if (saved && ['accepted','suppressed','draft'].includes(saved.state)) return {...saved,workflowId};
  const reason = observed?.version === 1 && observed.stage === 'generation' ? 'generation_unconfirmed' : 'workflow_receipt_unverified';
  const baseline: ChannelOutcome = {workflowId,stage: observed?.stage === 'generation' || observed?.stage === 'delivery' ? observed.stage : 'admission',
    state: observed?.state === 'failed' ? 'failed' : 'unknown',reason};
  throw new ChannelMessageReconciliationError({...baseline,...saved,workflowId});
}

/** Retry path: no Temporal signal/start, media lookup, model, billing or send. */
export async function reconcileChannelMessage(input: VerifiedChannelMessage) {
  let result;
  try { result = await WorkflowService.getInstance().getFinishedWorkflowResult(operationId(input)); }
  catch { /* Even after Temporal retention, the exact saved receipt may be conclusive. */ }
  return await resolveOriginal(input,result);
}

export async function admitChannelMessage(input: VerifiedChannelMessage) {
  const { siteId, channel, connectionId, originMessageId, source } = input;
  let result;
  try { result = await WorkflowService.getInstance().customerSupportMessage({
    site_id: siteId, userId: input.userId, message: input.message,
    origin: channel, origin_message_id: originMessageId,
    name: input.name, email: input.email, phone: input.phone,
    channel_delivery: true, website_chat_origin: false,
    custom_data: {
      source: 'zavu_inbound_message', connection_id: connectionId, channel,
      zavu_sender_id: source.senderId, zavu_from: source.from, attachments: input.attachments,
    },
  }, {
    priority: 'high', async: false, retryAttempts: 3, taskQueue: 'high',
    workflowId: operationId(input),
  }); } catch { /* An RPC failure does not prove the workflow or provider did nothing. */ }
  return await resolveOriginal(input,result);
}