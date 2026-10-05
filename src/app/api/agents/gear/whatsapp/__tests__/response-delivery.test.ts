import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import type { AssistantRecoveryScope } from '@/lib/services/robot-instance/assistant-recovery-schema';

type AsyncMock = (...args: any[]) => Promise<any>;
const platform = jest.fn<AsyncMock>();
const audio = jest.fn<AsyncMock>();
const from = jest.fn();
let latest: any;
let query: any;
let queryError: any;
const scope: AssistantRecoveryScope = { instanceId: 'instance', siteId: 'site', userId: 'user', userMessageLogId: 'action' };
const originalEnv = process.env;

jest.unstable_mockModule('@/lib/services/whatsapp/WhatsAppSendService', () => ({ WhatsAppSendService: { sendMessage: platform } }));
jest.unstable_mockModule('@/lib/utils/whatsapp-formatter', () => ({ formatMarkdownForWhatsApp: (text: string) => text }));
jest.unstable_mockModule('@/lib/services/channels/long-reply-audio', () => ({ tryPrepareLongReplyAudio: audio }));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/services/robot-instance/assistant-executor', () => ({ executeAssistant: jest.fn() }));
jest.unstable_mockModule('../tools', () => ({ createAccountTool: {}, verifyAccountTool: {} }));
jest.unstable_mockModule('@/app/api/agents/tools/instance_project/assistantProtocol', () => ({ instanceProjectTool: {} }));
jest.unstable_mockModule('@/lib/utils/phone-normalizer', () => ({ normalizePhoneForStorage: (phone: string) => phone }));
jest.unstable_mockModule('@/lib/custom-automation/ai-agent-executor', () => ({ AIAgentExecutor: class {} }));

let send: typeof import('../steps').sendWhatsAppResponse;
let sendError: typeof import('../steps').sendWhatsAppError;
beforeAll(async () => { ({ sendWhatsAppResponse: send, sendWhatsAppError: sendError } = await import('../steps')); });
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { NODE_ENV: 'test' };
  latest = { id: 'action', instance_id: 'instance', site_id: 'site', user_id: 'user',
    log_type: 'user_action', trusted_user_action: true,
    details: { status: 'completed', assistant_recovery: { respawnCount: 0 } } };
  queryError = null;
  query = {};
  for (const method of ['select', 'eq', 'order', 'limit']) query[method] = jest.fn().mockReturnValue(query);
  query.maybeSingle = jest.fn<AsyncMock>().mockImplementation(async () => ({ data: latest, error: queryError }));
  from.mockReturnValue(query);
  audio.mockResolvedValue(null);
  platform.mockResolvedValue({ success: true, message_id: 'outbound' });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected live request'));
  for (const method of ['log', 'warn', 'error'] as const) jest.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

const deliver = (text = 'Respuesta actual', owner: AssistantRecoveryScope | undefined = scope) =>
  send('+15555550100', text, 'site', undefined, owner);

describe('WhatsApp outbound ownership and side effects', () => {
  it('sends the latest completed action and checks scope again immediately before delivery', async () => {
    expect(await deliver()).toBe(true);
    expect(query.maybeSingle).toHaveBeenCalledTimes(2);
    expect(query.eq.mock.calls.slice(0, 4)).toEqual([
      ['instance_id', 'instance'], ['site_id', 'site'], ['log_type', 'user_action'], ['trusted_user_action', true],
    ]);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(platform).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(send.maxRetries).toBe(0);
    expect(sendError.maxRetries).toBe(0);
  });

  it.each(['cancelled', 'stopped', 'paused', 'failed'])('suppresses a %s action without preparing audio or sending', async status => {
    latest.details.status = status;
    expect(await deliver()).toBe(false);
    expect(audio).not.toHaveBeenCalled();
    expect(platform).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'newer-action' }, { user_id: 'another-member' }, { instance_id: 'other-instance' },
    { site_id: 'other-site' }, { trusted_user_action: false }, { log_type: 'assistant_message' },
  ])('rejects superseded, foreign or untrusted database rows: %j', async patch => {
    Object.assign(latest, patch);
    expect(await deliver()).toBe(false);
    expect(platform).not.toHaveBeenCalled();
  });

  it.each([null, { respawnCount: 1 }, { respawnCount: 0, lease_token: 'claimed-generation' }])(
    'fails closed on missing rows or changed recovery ownership: %j', async recovery => {
      if (recovery === null) latest = null;
      else latest.details.assistant_recovery = recovery;
      expect(await deliver()).toBe(false);
      expect(platform).not.toHaveBeenCalled();
    },
  );

  it('suppresses a database lookup failure instead of sending unscoped', async () => {
    queryError = { message: 'Database unavailable' };
    expect(await deliver()).toBe(false);
    expect(platform).not.toHaveBeenCalled();
  });

  it('rejects an incomplete or foreign supplied scope', async () => {
    expect(await deliver('Answer', { ...scope, siteId: 'other-site' })).toBe(false);
    expect(await deliver('Answer', { ...scope, userMessageLogId: '' })).toBe(false);
    expect(await deliver('Answer', { ...scope, generation: -1 })).toBe(false);
    expect(from).not.toHaveBeenCalled();
    expect(platform).not.toHaveBeenCalled();
  });

  it('rechecks after audio preparation so newer input suppresses an already generated answer', async () => {
    audio.mockImplementationOnce(async () => { latest.id = 'newer-action'; return null; });
    expect(await deliver()).toBe(false);
    expect(platform).not.toHaveBeenCalled();
  });

  it('stops remaining chunks if the action is superseded after the first delivery', async () => {
    platform.mockImplementationOnce(async () => { latest.id = 'newer-action'; return { success: true }; });
    expect(await deliver('x'.repeat(1600))).toBe(false);
    expect(platform).toHaveBeenCalledTimes(1);
  });

  it('recognizes a platform rejection and does not continue sending remaining chunks', async () => {
    platform.mockResolvedValue({ success: false });
    expect(await deliver('x'.repeat(1600))).toBe(false);
    expect(platform).toHaveBeenCalledTimes(1);
  });

  it('preserves unscoped compatibility only when scope is omitted', async () => {
    expect(await send('+15555550100', 'Lobby answer', 'site')).toBe(true);
    expect(from).not.toHaveBeenCalled();
    expect(platform).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'rejection', 'success'])('never uses another provider after a custom Twilio send: %s', async outcome => {
    process.env.GEAR_TWILIO_ACCOUNT_SID = randomBytes(16).toString('hex');
    process.env.GEAR_TWILIO_AUTH_TOKEN = randomBytes(24).toString('hex');
    process.env.GEAR_TWILIO_PHONE_NUMBER = '+15555550101';
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;
    if (outcome === 'network') fetchMock.mockRejectedValueOnce(new Error('Acceptance unknown'));
    else fetchMock.mockResolvedValueOnce(new Response('{}', { status: outcome === 'success' ? 201 : 500 }));
    expect(await deliver()).toBe(outcome === 'success');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(query.maybeSingle).toHaveBeenCalledTimes(2);
    expect(platform).not.toHaveBeenCalled();
  });
});