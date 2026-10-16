import { getAudienceById, getAudiencePageForSending, updateAudienceLeadStatus } from '@/lib/database/audience-db';
import { resolveDeliveryRoutes, type DeliveryRoute } from '@/lib/messaging/delivery-routing';
import { buildToolExecutionContext, readToolExecutionContext, type ToolExecutionContext } from '@/lib/services/tool-execution-context';
import type { SendBulkMessagesToolParams } from './definition';
import { validateBulkRoutes } from './validation';

export interface BulkExecutionIO {
  page: typeof getAudiencePageForSending;
  status: typeof updateAudienceLeadStatus;
}

export function recipientContextForBulk(siteId: string, args: SendBulkMessagesToolParams, executionContext?: ToolExecutionContext) {
  const inherited = readToolExecutionContext(executionContext, siteId);
  return (voiceData: Record<string, string> = {}) => {
    const envelope = buildToolExecutionContext({
      site_id: siteId,
      intent: voiceData.voice_objective || inherited?.intent,
      background: voiceData.voice_additional_context || (inherited?.source.conversation_id || inherited?.source.message_id
        ? undefined : inherited?.background),
      source: {
        tool: inherited?.source.tool === 'publish' ? 'publish' : 'sendBulkMessages',
        instance_id: inherited?.source.instance_id, node_id: inherited?.source.node_id,
        audience_id: args.audience_id, content_id: args.content_id ?? inherited?.source.content_id,
      },
    });
    return envelope ? { tool_execution_context: envelope } : {};
  };
}

/** Snapshot pending recipients once: audience send_status is shared across routes. */
export async function executeBulkRoutes(
  siteId: string,
  args: SendBulkMessagesToolParams,
  executionContext: ToolExecutionContext | undefined,
  executeSingle: (args: SendBulkMessagesToolParams, context: ToolExecutionContext | undefined, io: BulkExecutionIO) => Promise<any>,
) {
  try {
    const routes = await resolveDeliveryRoutes(siteId, args);
    validateBulkRoutes(args, routes);
    const audience = await getAudienceById(args.audience_id);
    if (!audience || audience.site_id !== siteId || audience.status !== 'ready') throw new Error('Audience must be ready and belong to this site.');
    if (routes.length === 1) return await executeSingle({ ...args, ...routes[0], delivery_routes: undefined }, executionContext,
      { page: getAudiencePageForSending, status: updateAudienceLeadStatus });
    const pages = new Map<number, Awaited<ReturnType<typeof getAudiencePageForSending>>>();
    for (let page = 1; page <= Math.ceil(audience.total_count / audience.page_size); page++) {
      pages.set(page, await getAudiencePageForSending(args.audience_id, page));
    }
    const statuses = new Map<string, { status: 'sent' | 'failed' | 'skipped'; error?: string }[]>();
    const io: BulkExecutionIO = {
      page: async (_id, page) => pages.get(page)!,
      status: async (_id, lead, status, error) => {
        if (status === 'pending') throw new Error('Invalid delivery status.');
        const entries = statuses.get(lead) ?? [];
        entries.push({ status, error });
        statuses.set(lead, entries);
      },
    };
    const results = [];
    for (const route of routes) {
      const { channel: _channel, connection_id: _connection, audience_email_mode: _email, voice_mode: _voice, delivery_routes: _routes, ...rest } = args;
      let result;
      try {
        result = await executeSingle({ ...rest, ...route,
          ...(route.voice_mode !== 'agent_call' ? { objective: undefined, additional_context: undefined } : {}) }, executionContext, io);
      } catch {
        // Preserve earlier handoffs in the aggregate status; an exception must
        // not leave their recipients pending for an automatic duplicate replay.
        result = { success: false, error: 'Route execution failed; inspect existing delivery records before retrying.' };
      }
      results.push({ ...route, result });
      if (!result.success) break; // Do not blindly continue after a provider/preparation failure.
    }
    for (const [lead, entries] of statuses) {
      const incomplete = entries.length !== routes.length;
      const failed = entries.find(entry => entry.status === 'failed');
      const status = incomplete || failed ? 'failed' : entries.some(entry => entry.status === 'sent') ? 'sent' : 'skipped';
      await updateAudienceLeadStatus(args.audience_id, lead, status, failed?.error ?? (incomplete ? 'Incomplete multi-route delivery; inspect queued/sent destinations before retrying.' : undefined));
    }
    return { success: results.length === routes.length && results.every(entry => entry.result.success), audience_id: args.audience_id, delivery_routes: results };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}