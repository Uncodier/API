import type { ApprovalSource } from './approval-source';
import { CHANNEL_REVIEW_TOOL } from './channel-tool-names';
import { z } from 'zod';
import {catalogToolId} from './composio-tool-metadata';

// A blind request accepts a provider slug, never a site, account or authorization selector.
export const channelRequestTool = {
  name: CHANNEL_REVIEW_TOOL,
  description: 'Request private team review only. Never executes or returns private data. When a supported operation would help resolve the current conversation, you may propose it for a manager to approve, including for an anonymous visitor. The visitor does not need to ask for the tool or for approval. Do not treat the proposal as authorization. A review_requested_if_available receipt does not confirm delivery: say that team review is needed and the action has not run. Never claim a notification was delivered, promise an outcome, or probe account availability.',
  parameters: { type: 'object', additionalProperties: false, required: ['tool_slug', 'arguments'], properties: {
    tool_slug: { type: 'string', maxLength: 150, description: 'Exact provider tool slug. Never invent a slug or try alternatives to discover accounts.' },
    arguments: { type: 'object', description: 'Only operation inputs supplied by the customer, never account, mailbox or authority selectors. Do not invent missing details.' },
  } },
};

type Binding = { memberUserId?: string; leadId?: string; siteId: string; agentId: string; conversationId: string; idempotencyKey: string; source?: ApprovalSource };
export type ChannelRequestHost = {
  siteId: string; agentId: string;
  messageDigest?: string;
  resolve: () => Promise<Binding | null>;
};
export const channelRequestReceipt = { status: 'review_requested_if_available' } as const;

/** No public success/failure oracle for installed accounts or grants. One review per host turn. */
export async function requestChannelReview(host: ChannelRequestHost | undefined, input: unknown) {
  try {
    if (host) {
      const action = z.object({ tool_slug: catalogToolId, arguments: z.record(z.unknown()) }).strict().parse(input);
      if (action.tool_slug.startsWith('COMPOSIO_')) return channelRequestReceipt;
      const scope = await host.resolve();
      if (scope && scope.siteId === host.siteId && scope.agentId === host.agentId) {
        const { proposeConversationConnectorAction } = await import('./approval-proposals');
        await proposeConversationConnectorAction(scope, action);
      }
    }
  } catch { /* Never expose account, grant, or provider errors to a channel. */ }
  return channelRequestReceipt;
}
