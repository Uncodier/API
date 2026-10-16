import { NextResponse } from 'next/server';
import { z } from 'zod';
import { canAccessSite } from '@/lib/security/site-access';
import { loadExactDeliveryContext } from '@/lib/messaging/exact-delivery-context';
import { sendExactDelivery } from '@/lib/messaging/exact-delivery';
import { resolveOutreachRecipient } from '@/lib/services/outreach/recipients';
import { loadOutreachConversations } from '@/lib/services/outreach/recipient-repository';
import { claimExactDelivery, finishExactDelivery } from '@/lib/messaging/exact-delivery-receipt';

const schema = z.object({
  site_id: z.string().uuid(), channel: z.enum(['email', 'whatsapp', 'sms', 'telegram', 'voice']),
  connection_id: z.string().min(1).max(200).optional(),
  to: z.string().trim().min(1).max(320).optional(), message: z.string().min(1).max(200_000).optional(),
  subject: z.string().max(1000).optional(), message_id: z.string().uuid(),
  conversation_id: z.string().uuid().optional(), lead_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(), voice_mode: z.enum(['tts', 'agent_call']).optional(),
  objective: z.string().max(500).optional(), additional_context: z.string().max(4000).optional(),
  tool_execution_context: z.unknown().optional(), omit_signature: z.boolean().optional(),
}).strict();

/** Durable workers provide message_id; stored routing is authoritative at every attempt. */
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid exact delivery' }, { status: 400 });
  if (!await canAccessSite(request, parsed.data.site_id)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
  try {
    const context = await loadExactDeliveryContext(parsed.data);
    if (!context.connectionId || !context.hasStoredConnection || context.message?.role !== 'assistant') {
      return NextResponse.json({ success: false, error: 'Exact stored assistant selection required' }, { status: 409 });
    }
    const receipt = context.customData.exact_delivery_receipt;
    if (receipt?.state === 'accepted' && receipt.connection_id === context.connectionId) {
      return NextResponse.json({ ...receipt.result, duplicate: true }, { status: 200 });
    }
    const conversations = context.leadId ? await loadOutreachConversations(parsed.data.site_id, context.leadId) : [];
    const recipient = resolveOutreachRecipient({ siteId: parsed.data.site_id, channel: parsed.data.channel,
      lead: context.lead, conversations });
    if (!recipient || !context.message?.content) return NextResponse.json({ success: false, error: 'Stored recipient or content is unavailable' }, { status: 409 });
    let attemptId: string | undefined;
    const result = await sendExactDelivery({ site_id: parsed.data.site_id, channel: parsed.data.channel,
      message_id: parsed.data.message_id, connection_id: context.connectionId, conversation_id: context.conversationId,
      lead_id: context.leadId, to: recipient.recipient, message: context.message.content,
      before_dispatch: async () => { attemptId = await claimExactDelivery(context.message, context.connectionId!); } });
    if (attemptId) await finishExactDelivery(parsed.data.message_id, attemptId, result);
    return NextResponse.json({ ...result, recipient: recipient.recipient }, { status: result.success ? 200 : 409 });
  } catch {
    return NextResponse.json({ success: false, error: 'Stored delivery context is unavailable' }, { status: 409 });
  }
}