import { createHash, randomUUID } from 'node:crypto';
import { getSiteLicensedResources } from '@/lib/billing/licensed-resources';
import { assertAutomationSendAllowed, AutomationSendSuppressed } from '../channels/automation-send-guard';
import { hasTextWindow, textRoutePlan, textRoutes } from './routed-text-policy';
import { attemptRoutedText, type TextRoute, type TextTemplate } from './routed-text-provider';
import { loadRoutedText, reconcileRoutedLeadPhone, writeRoutedText, type RoutedContext, type RoutedIdentity } from './routed-text-store';
import { RoutedTextRecipientError } from './routed-text-identity';

const field = 'whatsapp_text_delivery';
const conflict = () => new Error('Routed WhatsApp delivery requires reconciliation');
const sameRoute = (a: TextRoute, b: TextRoute) => a.connectionId === b.connectionId && a.provider === b.provider && a.sender === b.sender;
const providerId = (id: unknown): id is string => typeof id === 'string' && !!id.trim() && id !== 'unknown';
const scopeKey = (id: RoutedIdentity, ctx: RoutedContext) => createHash('sha256').update(JSON.stringify([
  id.site_id, id.conversation_id, id.message_id, ctx.role, ctx.content, ctx.text, ctx.recipient,
])).digest('hex');

interface Receipt {
  key: string;
  state: 'ready' | 'attempting' | 'pending' | 'accepted' | 'failed' | 'unknown';
  routes: TextRoute[];
  refused: { connection_id: string; reason: string }[];
  started_at: number;
  recipient: string;
  route?: TextRoute;
  attempt_id?: string;
  template?: TextTemplate;
  provider_message_id?: string;
  reason?: string;
}

function response(id: RoutedIdentity, r: Receipt) {
  const status = r.state === 'accepted' ? 'accepted' : r.state === 'pending' ? 'template_pending'
    : r.state === 'failed' ? 'failed' : 'needs_reconciliation';
  return { status, success: status === 'accepted' || status === 'template_pending', message_id: id.message_id,
    connection_id: r.route?.connectionId, provider: r.route?.provider, template_id: r.template?.id,
    ...(r.state === 'pending' ? { attempt_id: r.attempt_id } : {}),
    provider_message_id: r.provider_message_id, reason: r.reason };
}

function freshSendAllowed(ctx: Pick<RoutedContext, 'metadata' | 'role'>) {
  const d = ctx.metadata;
  if (['completed', 'success', 'failed', 'cancelled'].includes(d.command_status)) return false;
  if (['provider_message_id', 'twilio_message_id', 'external_message_id', 'sent_at', 'accepted_at', 'delivered_at',
    'whatsapp_message_id', 'read_at', 'exact_delivery_receipt', 'audio_delivery', 'template_delivery', 'pinned_text_delivery', 'native_media_delivery',
    'template_sid', 'template_id', 'needs_reconciliation'].some(key => !!d[key])) return false;
  return ['sending', 'approved', 'ready', 'accepted'].includes(d.status) || (ctx.role === 'team_member' && d.status === 'pending');
}

async function currentPlan(siteId: string, ctx: RoutedContext) {
  const { channels } = await getSiteLicensedResources(siteId);
  return textRoutePlan(textRoutes(channels), ctx.metadata, ctx.conversation, ctx.inbound, channels);
}

export async function sendRoutedText(id: RoutedIdentity) {
  // A fresh read + CAS per transition also serializes manual and scheduled workflows for one message.
  for (;;) {
    let ctx: RoutedContext;
    try { ctx = await loadRoutedText(id); } catch (err) {
      // Bad preflight data is not a transport failure: surface a correctable
      // message error, but only if no provider or other flow owns this row.
      if (!(err instanceof RoutedTextRecipientError) || !err.snapshot) throw err;
      const row = err.snapshot;
      if (row.metadata[field] || !freshSendAllowed(row)) throw err;
      await assertAutomationSendAllowed({ ...id, message: row.content });
      await writeRoutedText(id, row, row.metadata, { ...row.metadata, status: 'failed', command_status: 'failed',
        error_message: err.message, error_code: 'WHATSAPP_RECIPIENT_UNVERIFIED' });
      return { message_id: id.message_id, status: 'failed', success: false, reason: err.message };
    }
    const previous = ctx.metadata;
    const key = scopeKey(id, ctx);
    let receipt: Receipt | undefined = previous[field];
    if (previous.automation_skipped) return { success: true, status: 'skipped', skipped: true,
      message_id: id.message_id, reason: 'Saved WhatsApp send was suppressed.' };
    if (receipt) {
      if (receipt.key !== key || !Array.isArray(receipt.routes) || !Array.isArray(receipt.refused)) throw conflict();
      if (receipt.state === 'accepted') {
        if (!providerId(receipt.provider_message_id) || previous.provider_message_id !== receipt.provider_message_id) throw conflict();
        // A signed delivery failure after placement is not a new fallback opportunity.
        return response(id, previous.status === 'failed' ? { ...receipt, state: 'failed' } : receipt);
      }
      if (['failed', 'unknown', 'attempting'].includes(receipt.state)) return response(id, receipt);
      if (!['pending', 'ready'].includes(receipt.state) || previous.provider_message_id || previous.twilio_message_id
        || previous.exact_delivery_receipt || previous.template_delivery || previous.audio_delivery
        || !Number.isFinite(receipt.started_at) || (receipt.state === 'pending' && (!providerId(receipt.template?.id) || !receipt.route))
        || (receipt.state === 'pending' ? previous.status !== 'queued' : previous.status !== 'routing')) throw conflict();
    }
    await assertAutomationSendAllowed({ ...id, message: ctx.content });
    if (!receipt && !freshSendAllowed(ctx)) throw conflict();
    const allowed = await currentPlan(id.site_id, ctx);
    receipt ??= { key, state: 'ready', routes: allowed, refused: [], started_at: Date.now(), recipient: ctx.recipient };
    const write = async (r: Receipt, status: string, extras: Record<string, unknown> = {}) => {
      await writeRoutedText(id, ctx, previous, { ...previous, [field]: r, status, ...extras });
      return response(id, r);
    };
    const expired = () => Date.now() - receipt!.started_at >= 24 * 3600_000;
    // At the last timer the template might already be approved. Allow exactly
    // the saved route + template to check approval and, if confirmed, dispatch.
    // Never create a template or start a new fallback past the deadline.
    if (expired() && receipt.state !== 'pending') {
      return write({ ...receipt, state: 'unknown', reason: 'WhatsApp routing deadline elapsed; check the saved receipt.' },
        'needs_reconciliation', { needs_reconciliation: true });
    }
    const route = receipt.state === 'pending' ? receipt.route : receipt.routes.find(r => allowed.some(a => sameRoute(a, r))
      && !receipt!.refused.some(item => item.connection_id === r.connectionId));
    if (!route || !allowed.some(a => sameRoute(a, route))) {
      // A pending approval belongs to that sender. Never reinterpret it on a new account.
      if (receipt.state === 'pending') return write({ ...receipt, state: 'unknown', reason: 'Pending WhatsApp sender changed.' },
        'needs_reconciliation', { needs_reconciliation: true });
      const reason = 'No eligible WhatsApp connection remains for this message.';
      return write({ ...receipt, state: 'failed', reason }, 'failed', { command_status: 'failed', error_message: reason });
    }
    if (ctx.leadPhoneRepair) {
      if (previous[field]) throw conflict();
      await reconcileRoutedLeadPhone(id, ctx);
    }
    const claim: Receipt = { ...receipt, route, attempt_id: randomUUID(), state: 'attempting' };
    // Not `sending`: the hourly stuck-message reset must not release a live/ambiguous provider attempt.
    const owned = { ...previous, [field]: claim, status: 'placement_unknown', command_status: 'pending' };
    await writeRoutedText(id, ctx, previous, owned);
    const forceTemplate = receipt.refused.length > 0 || !hasTextWindow(route, ctx.inbound, ctx.recipient, Date.now());
    const verifyBinding = async () => {
      const live = await loadRoutedText(id);
      if (live.leadPhoneRepair || scopeKey(id, live) !== key || live.metadata[field]?.attempt_id !== claim.attempt_id
        || live.metadata[field]?.state !== 'attempting' || live.metadata.status !== 'placement_unknown'
        || live.metadata.provider_message_id || live.metadata.twilio_message_id || live.metadata.automation_skipped
        || !(await currentPlan(id.site_id, live)).some(r => sameRoute(r, route))
        || (!forceTemplate && !hasTextWindow(route, live.inbound, live.recipient, Date.now()))) throw conflict();
      await assertAutomationSendAllowed({ ...id, message: live.content });
    };
    let result: Awaited<ReturnType<typeof attemptRoutedText>>;
    try {
      result = await attemptRoutedText({ siteId: id.site_id, conversationId: id.conversation_id, messageId: id.message_id,
        text: ctx.text, recipient: ctx.recipient, route, template: receipt.template, forceTemplate, verifyBinding });
    } catch (err) {
      if (err instanceof AutomationSendSuppressed) throw err;
      result = { kind: 'unknown', reason: 'WhatsApp attempt could not be confirmed.' };
    }
    const finish = async (r: Receipt, status: string, extras: Record<string, unknown> = {}) => {
      await writeRoutedText(id, ctx, owned, { ...owned, [field]: r, status, ...extras });
      return response(id, r);
    };
    switch (result.kind) {
      case 'unavailable':
        // The only edge to a different connection: no placement and a sender-specific refusal.
        if (expired()) return finish({ ...claim, state: 'failed', reason: result.reason }, 'failed',
          { command_status: 'failed', error_message: result.reason });
        await finish({ ...claim, state: 'ready', template: undefined,
          refused: [...claim.refused, { connection_id: route.connectionId, reason: result.reason }] }, 'routing');
        continue;
      case 'pending':
        if (!providerId(result.template.id)) throw conflict();
        if (expired()) {
          const reason = 'WhatsApp approval was not confirmed at the routing deadline.';
          return finish({ ...claim, template: result.template, state: 'unknown', reason }, 'needs_reconciliation',
            { needs_reconciliation: true, error_message: reason });
        }
        return finish({ ...claim, state: 'pending', template: result.template }, 'queued');
      case 'accepted':
        if (!providerId(result.providerMessageId) || result.providerMessageId === id.message_id) throw conflict();
        return finish({ ...claim, state: 'accepted', provider_message_id: result.providerMessageId }, route.provider === 'zavu' ? 'queued' : 'sent', {
          command_status: route.provider === 'zavu' ? 'pending' : 'success', delivery_provider: route.provider, provider_message_id: result.providerMessageId,
          ...(route.provider === 'twilio' ? { twilio_message_id: result.providerMessageId } : {}), accepted_at: new Date().toISOString(), error_message: null });
      case 'failed': return finish({ ...claim, state: 'failed', reason: result.reason }, 'failed', { command_status: 'failed', error_message: result.reason });
      case 'unknown': return finish({ ...claim, state: 'unknown', reason: result.reason }, 'needs_reconciliation', { needs_reconciliation: true, error_message: result.reason });
    }
  }
}