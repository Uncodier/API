import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canAccessSite } from '@/lib/security/site-access';
import { getOutreachPolicy, localDay, outreachTimezone, selectedOutreachChannels, type OutreachActivityKey } from './policy';
import { availableOutreachRecipients } from './recipients';
import { loadOutreachConversations } from './recipient-repository';
import { outreachRepository } from './delivery';
import { summarizeOutreachHistory } from './history';

/** Managed-only boundary: caller leadData never authorizes generation/logging. */
export async function assertOutreachGeneration(request: Request, siteId: string, leadId: string, activity: OutreachActivityKey) {
  const denied = (message: string, status = 400): never => { throw { code: 'OUTREACH_NOT_ELIGIBLE', message, status }; };
  if (!await canAccessSite(request, siteId)) denied('Site access denied', 403);
  const [{ data: lead, error: le }, { data: settings, error: se }] = await Promise.all([
    supabaseAdmin.from('leads').select('*').eq('id', leadId).eq('site_id', siteId).maybeSingle(),
    supabaseAdmin.from('settings').select('channels,activities,business_hours').eq('site_id', siteId).maybeSingle(),
  ]);
  if (le || se) denied('Outreach configuration unavailable', 503);
  if (!lead) denied('Lead not found', 404);
  if (lead.metadata?.quarantined_cross_tenant || lead.assignee_id || lead.unsubscribed
    || lead.metadata?.unsubscribed === true || lead.metadata?.do_not_contact === true
    || !['new', 'contacted', 'qualified'].includes(lead.status)) denied('Lead is ineligible');
  const policy = getOutreachPolicy(settings, activity);
  if (!policy || policy.status !== 'active') return denied('Outreach inactive or invalid');
  if (!policy.all_segments && (!lead.segment_id || !policy.segment_ids.includes(lead.segment_id))) denied('Segment not selected');
  if (!policy.all_segments && !await outreachRepository.segmentBelongsToSite(siteId, lead.segment_id)) denied('Segment not selected');
  try {
    const day = localDay(new Date(), outreachTimezone(settings));
    if (activity === 'leads_follow_up' && !policy.weekdays.includes(day.weekday)) denied('Outside selected weekdays');
  } catch { denied('Outside selected weekdays or invalid timezone'); }
  const selected = selectedOutreachChannels(settings, policy);
  if (!selected.length) denied('No selected connected accounts');
  const conversations = await loadOutreachConversations(siteId, leadId);
  const recipients = availableOutreachRecipients({ siteId, lead, channels: selected, conversations });
  const channels = Object.keys(recipients);
  if (!channels.length) denied('No accessible recipient on selected channels');
  const history = summarizeOutreachHistory(await outreachRepository.history(siteId, leadId));
  if (history.uncertain) denied('A previous delivery requires reconciliation');
  if ((activity === 'leads_initial_cold_outreach') === history.hasInbound) denied('Outreach audience mismatch');
  if (history.unanswered >= policy.max_unanswered_messages) denied('Unanswered message limit reached');
  return { lead, channels, recipients };
}