import { createHash } from 'node:crypto';
import type { Client } from '@temporalio/client';
import { WorkflowNotFoundError } from '@temporalio/client';

interface ConversationScope {
  siteId?: string;
  conversationId?: string | null;
  origin?: string;
  channel_delivery?: boolean;
  custom_data?: Record<string, unknown>;
}

export interface ConversationMessageSubmission {
  workflowId: string;
  workflowType: 'customerSupportMessageWorkflow' | 'whatsappMessageWorkflow';
  args: unknown[];
  taskQueue: string;
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Scope only by a conversation or the complete internal Zavu ingress identity.
 * Never group unscoped traffic by site, lead, phone, or visitor alone.
 */
export function conversationIngressId(input: ConversationScope): string | undefined {
  if (!nonempty(input.siteId)) return undefined;
  let scope: string;
  const data = input.custom_data;
  if (data?.source === 'zavu_inbound_message' && input.channel_delivery === true &&
      data.channel === input.origin &&
      [data.channel, data.connection_id, data.zavu_sender_id, data.zavu_from].every(nonempty)) {
    scope = JSON.stringify(['zavu', data.channel, data.connection_id, data.zavu_sender_id, data.zavu_from]);
  } else if (nonempty(input.conversationId)) {
    scope = input.conversationId;
  } else {
    return undefined;
  }
  return `conversation-ingress-${input.siteId}-${createHash('sha256').update(scope).digest('hex')}`;
}

/** Signal acceptance is durable admission, not child startup. Async callers must
 * return the message workflowId without coordinator execution/run IDs or polling.
 */
export async function submitConversationMessage(
  client: Client,
  ingressId: string,
  submission: ConversationMessageSubmission,
): Promise<void> {
  await client.workflow.signalWithStart('conversationIngressWorkflow', {
    workflowId: ingressId,
    taskQueue: submission.taskQueue,
    args: [],
    signal: 'submitConversationMessage',
    signalArgs: [submission],
  });
}

/** Bound only the admission wait, not the child's result wait. Timing out does
 * not cancel a durably accepted message; callers can recover by its workflowId.
 */
export async function conversationMessageResult(
  client: Client,
  workflowId: string,
): Promise<unknown> {
  const pendingChild = client.workflow.getHandle(workflowId);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (true) {
    let runId: string;
    try {
      // Describe remains available after child completion and coordinator
      // continue-as-new/closure, unlike an ephemeral coordinator admission query.
      runId = (await pendingChild.describe()).runId;
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for conversation message admission: ${workflowId}. The accepted message has not been cancelled.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      continue;
    }
    return client.workflow.getHandle(workflowId, runId).result();
  }
}