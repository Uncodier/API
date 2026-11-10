import { NextResponse } from 'next/server';
import { z } from 'zod';
import { canAccessSite } from '@/lib/security/site-access';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const schema = z.object({ site_id: z.string().uuid(), conversation_id: z.string().uuid(), message_id: z.string().uuid() }).strict();

/** Read-only recovery. Never creates, submits, or dispatches a provider message. */
export async function GET(request: Request) {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  const headers = { 'Cache-Control': 'no-store, private' };
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid template status request' }, { status: 400, headers });
  const { site_id, conversation_id, message_id } = parsed.data;
  if (!await canAccessSite(request, site_id)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403, headers });
  const { data: conversation, error: scopeError } = await supabaseAdmin.from('conversations').select('id')
    .eq('id', conversation_id).eq('site_id', site_id).maybeSingle();
  if (scopeError) return NextResponse.json({ success: false, error: 'Status unavailable' }, { status: 503, headers });
  if (!conversation) return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404, headers });
  const { data: message, error } = await supabaseAdmin.from('messages').select('custom_data, role')
    .eq('id', message_id).eq('conversation_id', conversation_id).maybeSingle();
  if (error) return NextResponse.json({ success: false, error: 'Status unavailable' }, { status: 503, headers });
  if (!message || !['assistant', 'team_member'].includes(message.role)) return NextResponse.json({ success: false, error: 'Message not found' }, { status: 404, headers });
  const receipt = message.custom_data?.template_delivery;
  const providerId = receipt?.provider_message_id;
  const complete = ['accepted', 'sent', 'delivered', 'read'].includes(receipt?.state)
    && typeof providerId === 'string' && Boolean(providerId) && message.custom_data?.status !== 'failed'
    && receipt.delivery_status !== 'failed';
  const resume = !message.custom_data?.audio_delivery && ['pending', 'ready'].includes(receipt?.state)
    && message.custom_data?.status !== 'failed' && receipt.delivery_status !== 'failed'
    && typeof receipt?.template_id === 'string' && Boolean(receipt.template_id);
  return NextResponse.json({ success: true, recovery_action: complete ? 'complete' : resume ? 'resume' : 'stop',
    delivery_format: 'template', requested_response_format: 'audio', template_id: receipt?.template_id, template_state: receipt?.state,
    message_id: complete ? providerId : message_id, local_message_id: message_id,
    ...(complete ? { messageId: providerId, status: 'sent', template_used: true, template_pending: false,
      delivery_status: receipt.delivery_status || receipt.state }
      : resume ? { status: 'template_pending', template_used: false, template_pending: true, retry_after_seconds: 60 }
        : { status: receipt?.state === 'failed' || receipt?.state === 'rejected' ? 'failed' : 'placement_unknown', template_pending: false }),
  }, { headers });
}

/** Explicit control operation: mark a stopped poller, never mutate delivery ownership. */
export async function POST(request: Request) {
  const parsed = schema.extend({ action: z.literal('mark_reconciliation_required'), template_id: z.string().min(1).max(200) })
    .safeParse(await request.json().catch(() => null));
  const headers = { 'Cache-Control': 'no-store, private' };
  if (!parsed.success) return NextResponse.json({ success: false }, { status: 400, headers });
  const { site_id, conversation_id, message_id, template_id } = parsed.data;
  if (!await canAccessSite(request, site_id)) return NextResponse.json({ success: false }, { status: 403, headers });
  const { data: conversation, error: scopeError } = await supabaseAdmin.from('conversations').select('id')
    .eq('id', conversation_id).eq('site_id', site_id).maybeSingle();
  if (scopeError || !conversation) return NextResponse.json({ success: false }, { status: scopeError ? 503 : 404, headers });
  const { data: row, error } = await supabaseAdmin.from('messages').select('custom_data, role')
    .eq('id', message_id).eq('conversation_id', conversation_id).maybeSingle();
  if (error || !row) return NextResponse.json({ success: false }, { status: error ? 503 : 404, headers });
  const metadata = row.custom_data;
  const receipt = metadata?.template_delivery;
  if (!['assistant', 'team_member'].includes(row.role) || receipt?.template_id !== template_id) {
    return NextResponse.json({ success: false }, { status: 409, headers });
  }
  if (!['ready', 'pending'].includes(receipt.state) || metadata?.audio_delivery) {
    return NextResponse.json({ success: true, unchanged: true }, { headers });
  }
  const { data: updated, error: writeError } = await supabaseAdmin.from('messages').update({ custom_data: {
    ...metadata, needs_reconciliation: true, status: 'needs_reconciliation', command_status: 'pending',
    error_message: 'Template approval status could not be verified. Reconciliation is required before retrying.',
  } }).eq('id', message_id).eq('conversation_id', conversation_id).eq('custom_data', JSON.stringify(metadata)).select('id').maybeSingle();
  return NextResponse.json({ success: !writeError && Boolean(updated) }, { status: writeError ? 503 : updated ? 200 : 409, headers });
}