import { describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

type AsyncMock = (...args: any[]) => Promise<any>;

function setup() {
  const actionId = 'current-whatsapp-action';
  const claim = { eventId: 'message-1', token: randomUUID() };
  const authenticateGearWebhook = jest.fn<AsyncMock>().mockResolvedValue({
    ok: true,
    claim,
    webhookData: {
      From: 'whatsapp:+15555550100', To: 'whatsapp:+15555550101',
      MessageSid: 'message-1', Body: 'Consulta el estado', NumMedia: '0',
    },
  });
  const finishGearWebhookClaim = jest.fn<AsyncMock>().mockResolvedValue(undefined);
  const insertUserActionLog = jest.fn<AsyncMock>().mockResolvedValue({ id: actionId });
  const resetRequirementOnUserAction = jest.fn<AsyncMock>().mockResolvedValue(undefined);
  const start = jest.fn<AsyncMock>().mockResolvedValue({ runId: 'run-1' });
  const runGearAgentWorkflow = jest.fn();
  const resolveWhatsAppReplyContext = jest.fn<AsyncMock>().mockResolvedValue('');
  const finalizeWhatsAppAction = jest.fn<AsyncMock>().mockResolvedValue(true);
  const isCurrentWhatsAppAction = jest.fn<AsyncMock>().mockResolvedValue(true);
  const results: Record<string, unknown> = {
    sites: [{ id: 'site-1', name: 'Test site' }],
    site_members: [],
    remote_sessions: { site_id: 'site-1', instance_id: 'instance-1' },
    remote_instances: { status: 'running' },
  };
  const supabaseAdmin = {
    rpc: jest.fn<AsyncMock>().mockResolvedValue({ data: [{ id: 'user-1' }], error: null }),
    from: jest.fn((table: string) => {
      if (!Object.hasOwn(results, table)) throw new Error(`Unexpected table: ${table}`);
      const query: any = {};
      for (const method of ['select', 'eq', 'single', 'maybeSingle']) {
        query[method] = () => query;
      }
      query.then = (resolve: any, reject: any) => Promise.resolve({ data: results[table], error: null }).then(resolve, reject);
      return query;
    }),
  };
  const route = loadRuntimeModule<typeof import('../route')>(
    'src/app/api/agents/gear/whatsapp/webhook/route.ts', {
      'next/server': { NextResponse },
      '@/lib/database/supabase-client': { supabaseAdmin },
      'workflow/api': { start },
      '../workflow': { runGearAgentWorkflow, runUnregisteredGearAgentWorkflow: jest.fn() },
      '@/lib/services/requirement-cron-reset': { resetRequirementOnUserAction },
      '@/app/api/robots/instance/assistant/user-message-log': { insertUserActionLog },
      '@/lib/utils/phone-normalizer': {
        normalizePhoneForStorage: (phone: string) => phone,
        normalizePhoneForSearch: (phone: string) => [phone],
      },
      '@/lib/services/twilio/TwilioMediaTaskService': {},
      '@/lib/services/twilio/fetchTwilioMedia': {},
      '@/lib/services/ai/transcribeAudio': {},
      './twilio-webhook-auth': { authenticateGearWebhook, finishGearWebhookClaim },
      './reply-context': { resolveWhatsAppReplyContext },
      './inbound-action': {
        finalizeWhatsAppAction, isCurrentWhatsAppAction,
        unresolvedWhatsAppMediaContext: jest.fn<AsyncMock>().mockResolvedValue(''),
      },
      './inbound-media': {},
    },
  );
  const post = () => route.POST(new NextRequest('https://example.invalid/api/agents/gear/whatsapp/webhook', { method: 'POST' }));
  return { post, actionId, claim, authenticateGearWebhook, finishGearWebhookClaim,
    insertUserActionLog, resetRequirementOnUserAction, start, runGearAgentWorkflow, supabaseAdmin,
    resolveWhatsAppReplyContext, finalizeWhatsAppAction, isCurrentWhatsAppAction };
}

describe('Gear WhatsApp trusted user-action handoff', () => {
  it('starts the workflow with the exact running action persisted for this webhook', async () => {
    const h = setup();
    const response = await h.post();
    expect(response.status).toBe(200);
    expect(h.insertUserActionLog).toHaveBeenCalledTimes(1);
    expect(h.insertUserActionLog).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'instance-1', siteId: 'site-1', userId: 'user-1',
      message: 'Consulta el estado', skipDuplicateCheck: true,
      details: expect.objectContaining({ message_sid: 'message-1', status: 'running' }),
    }));
    expect(h.resetRequirementOnUserAction).toHaveBeenCalledWith('instance-1', h.actionId);
    expect(h.start).toHaveBeenCalledWith(h.runGearAgentWorkflow, [expect.objectContaining({
      instanceId: 'instance-1', siteId: 'site-1', userId: 'user-1',
      message: 'Consulta el estado', userMessageLogId: h.actionId,
    })]);
    expect(h.insertUserActionLog.mock.invocationCallOrder[0]).toBeLessThan(h.resetRequirementOnUserAction.mock.invocationCallOrder[0]);
    expect(h.resetRequirementOnUserAction.mock.invocationCallOrder[0]).toBeLessThan(h.start.mock.invocationCallOrder[0]);
    expect(h.finishGearWebhookClaim).toHaveBeenCalledWith(h.claim, 'completed');
  });

  it('never starts an unbound workflow if persisting the user action fails', async () => {
    const h = setup();
    h.insertUserActionLog.mockRejectedValue(new Error('Persistence unavailable'));
    expect((await h.post()).status).toBe(500);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.resetRequirementOnUserAction).not.toHaveBeenCalled();
    expect(h.finishGearWebhookClaim).toHaveBeenCalledWith(h.claim, 'failed', expect.stringContaining('Persistence unavailable'));
  });

  it('persists and forwards the exact scoped reply target alongside the current action', async () => {
    const h = setup();
    h.authenticateGearWebhook.mockResolvedValue({ ok: true, claim: h.claim, webhookData: {
      From: 'whatsapp:+15555550100', To: 'whatsapp:+15555550101',
      MessageSid: 'message-1', Body: 'Edit this image', NumMedia: '0', OriginalRepliedMessageSid: 'image-message',
    } });
    const context = '[WhatsApp reply target: image-message]\nQuoted image reference';
    h.resolveWhatsAppReplyContext.mockResolvedValue(context);
    expect((await h.post()).status).toBe(200);
    expect(h.resolveWhatsAppReplyContext).toHaveBeenCalledWith('instance-1', 'site-1', 'user-1', 'image-message');
    expect(h.insertUserActionLog).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Edit this image',
      details: expect.objectContaining({ message_sid: 'message-1', quoted_message_sid: 'image-message' }),
    }));
    expect(h.finalizeWhatsAppAction).toHaveBeenCalledWith(expect.objectContaining({ userMessageLogId: h.actionId }),
      `Edit this image\n\n${context}`, undefined);
    expect(h.start).toHaveBeenCalledWith(h.runGearAgentWorkflow, [expect.objectContaining({
      message: `Edit this image\n\n${context}`, userMessageLogId: h.actionId,
    })]);
  });

  it('does not persist or launch work when webhook admission is denied', async () => {
    const h = setup();
    h.authenticateGearWebhook.mockResolvedValue({ ok: false, response: new NextResponse(null, { status: 503 }) });
    expect((await h.post()).status).toBe(503);
    expect(h.supabaseAdmin.rpc).not.toHaveBeenCalled();
    expect(h.insertUserActionLog).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('does not reset requirements or start when a newer action already owns the instance', async () => {
    const h = setup();
    h.isCurrentWhatsAppAction.mockResolvedValue(false);
    expect((await h.post()).status).toBe(200);
    expect(h.resetRequirementOnUserAction).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('does not restart an action whose input was frozen by recovery before finalization', async () => {
    const h = setup();
    h.finalizeWhatsAppAction.mockResolvedValue(false);
    expect((await h.post()).status).toBe(200);
    expect(h.start).not.toHaveBeenCalled();
  });
});