import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface InboundActionScope {
  instanceId: string;
  siteId: string;
  userId: string;
  userMessageLogId: string;
  messageSid: string;
}

export interface WhatsAppMediaState {
  status: 'pending' | 'ready' | 'partial' | 'failed';
  items: Array<{
    index: number;
    contentType?: string;
    status: 'pending' | 'ready' | 'failed';
    transcription?: 'ready' | 'failed';
  }>;
}

function scopedAction(scope: InboundActionScope) {
  return supabaseAdmin.from('instance_logs')
    .select('id,details')
    .eq('id', scope.userMessageLogId).eq('instance_id', scope.instanceId)
    .eq('site_id', scope.siteId).eq('user_id', scope.userId)
    .eq('log_type', 'user_action').eq('trusted_user_action', true)
    .eq('details->>message_sid', scope.messageSid);
}

/** Same durable latest-action rule as assistant-recovery, not a distributed lock. */
export async function isCurrentWhatsAppAction(scope: InboundActionScope): Promise<boolean> {
  const { data: action, error: actionError } = await scopedAction(scope).maybeSingle();
  if (actionError) throw new Error('Failed to read WhatsApp action ownership');
  if (!action || action.details?.status !== 'running' || action.details?.assistant_recovery) return false;
  // Another authorized instance member's action also supersedes this turn.
  const { data, error } = await supabaseAdmin.from('instance_logs').select('id')
    .eq('instance_id', scope.instanceId).eq('site_id', scope.siteId)
    .eq('log_type', 'user_action').eq('trusted_user_action', true)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (error) throw new Error('Failed to read latest WhatsApp action');
  return data?.[0]?.id === scope.userMessageLogId;
}

/**
 * Enrich only the admitted row, including when superseded. Never reinsert it or
 * change its ordering/status. Before workflow initialization details are small;
 * compare the entire JSON to preserve concurrent cancellation/requirement tags.
 * Once recovery has frozen the turn, fail closed rather than rewrite its input.
 */
export async function finalizeWhatsAppAction(
  scope: InboundActionScope, message: string, media?: WhatsAppMediaState,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await scopedAction(scope).maybeSingle();
    if (error) throw new Error('Failed to read admitted WhatsApp message');
    if (!data || !data.details || typeof data.details !== 'object' || Array.isArray(data.details)) return false;
    const details = data.details;
    if (Object.hasOwn(details, 'assistant_recovery')) return false;
    const observed = JSON.stringify(details);
    if (observed.length > 16_000) return false;
    const { data: saved, error: saveError } = await supabaseAdmin.from('instance_logs')
      .update({ message, details: { ...details, ...(media ? { whatsapp_media: media } : {}) } })
      .eq('id', scope.userMessageLogId).eq('instance_id', scope.instanceId)
      .eq('site_id', scope.siteId).eq('user_id', scope.userId)
      .eq('log_type', 'user_action').eq('trusted_user_action', true)
      .eq('details->>message_sid', scope.messageSid)
      .eq('details', observed).select('id').maybeSingle();
    if (saveError) throw new Error('Failed to finalize admitted WhatsApp message');
    if (saved?.id === scope.userMessageLogId) return true;
  }
  return false;
}

/** A later turn may proceed, but unavailable media is never substitute evidence. */
export async function unresolvedWhatsAppMediaContext(scope: InboundActionScope): Promise<string> {
  const { data, error } = await supabaseAdmin.from('instance_logs')
    .select('details').eq('instance_id', scope.instanceId).eq('site_id', scope.siteId)
    .eq('log_type', 'user_action').eq('trusted_user_action', true)
    .in('details->whatsapp_media->>status', ['pending', 'partial', 'failed'])
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(20);
  if (error) throw new Error('Failed to inspect pending WhatsApp media');
  const unresolved = (data ?? []).filter((row: any) => row.details?.message_sid &&
    ['pending', 'partial', 'failed'].includes(row.details?.whatsapp_media?.status));
  if (!unresolved.length) return '';
  return '[WhatsApp media availability]\n' + unresolved.map((row: any) =>
    `Message ${JSON.stringify(row.details.message_sid)}: ${row.details.whatsapp_media.status}.`,
  ).join('\n') + '\nPending/failed attachments or voice transcriptions are not available evidence. ' +
    'Do not infer their contents or substitute another recent image/asset. If the request depends on them, ' +
    'explain the pending/failure state and ask the user to retry or identify the exact available attachment. ' +
    'Do not perform dependent edits or sends until the intended media is available.';
}