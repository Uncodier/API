import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sanitizeHarnessData, type HarnessDiagnosticContext } from './context';

/** Recipient is server-owned platform support configuration, never supplied by a model or a customer log. */
export async function deliverHarnessSupportTicket(ticket: Record<string, any>, context: HarnessDiagnosticContext) {
  const target = process.env.HARNESS_SUPPORT_EMAIL || process.env.UNCODIE_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL;
  if (!target || !z.string().email().safeParse(target).success) {
    return { state: 'unconfigured', email_sent: false, ticket_id: ticket.id,
      message: 'Ticket stored, but no valid platform support recipient is configured. Set HARNESS_SUPPORT_EMAIL on the server.' };
  }
  if (!process.env.SENDGRID_API_KEY?.trim()) {
    return { state: 'unconfigured', email_sent: false, ticket_id: ticket.id,
      message: 'Ticket stored; configure SENDGRID_API_KEY before retrying this same ticket. No delivery was attempted.' };
  }
  // Claim once before sending. A crash after provider acceptance is unknown, not permission to send another email.
  const { data: claimed, error } = await supabaseAdmin.from('requirement_harness_decisions')
    .update({ email_state: 'sending', email_attempted_at: new Date().toISOString() })
    .eq('id', ticket.id).eq('site_id', context.siteId).eq('decision', 'escalate_support')
    .in('email_state', ['pending', 'unconfigured']).select('id').maybeSingle();
  if (error) return { state: 'unavailable', email_sent: false, ticket_id: ticket.id };
  if (!claimed) {
    const { data: current } = await supabaseAdmin.from('requirement_harness_decisions').select('email_state')
      .eq('id', ticket.id).eq('site_id', context.siteId).maybeSingle();
    return { state: current?.email_state || 'unknown', email_sent: current?.email_state === 'sent', ticket_id: ticket.id };
  }
  const url = `https://app.makinari.com/robots?instance=${encodeURIComponent(context.instanceId)}`;
  const body = sanitizeHarnessData({ ticket_id: ticket.id, requirement_id: ticket.requirement_id,
    instance_url: url, reason: ticket.reason, ...ticket.payload });
  let sent = false;
  try {
    const { sendGridService } = await import('@/lib/services/sendgrid-service');
    const escaped = JSON.stringify(body, null, 2).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
    const result = await sendGridService.sendEmail({ to: target,
      subject: `[Harness] Soporte técnico — ${ticket.id}`,
      html: `<h1>Incidencia técnica del harness</h1><p>No es una solicitud de aprobación de producto al cliente.</p><pre>${escaped}</pre>`,
      categories: ['harness-technical-support'],
    });
    sent = result.success === true;
  } catch { /* Persist a bounded outcome, never raw provider errors or recipient secrets. */ }
  const state = sent ? 'sent' : 'failed';
  const { error: saveError } = await supabaseAdmin.from('requirement_harness_decisions')
    .update({ email_state: state, email_error: sent ? null : 'Provider did not confirm delivery.' })
    .eq('id', ticket.id).eq('site_id', context.siteId).eq('email_state', 'sending');
  return { state: saveError ? 'unknown' : state, email_sent: sent, ticket_id: ticket.id,
    ...(saveError ? { message: 'Delivery outcome could not be persisted; do not automatically resend.' } : {}) };
}