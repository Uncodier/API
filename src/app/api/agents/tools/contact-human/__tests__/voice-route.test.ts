const mockFrom = jest.fn();
const mockNotifyTeam = jest.fn();
const mockGetTeamMembers = jest.fn();
const mockNotifyVisitor = jest.fn();
const mockSendWhatsApp = jest.fn();
const mockSendChannel = jest.fn();
const mockAfter = jest.fn();

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: (...args: unknown[]) => mockAfter(...args),
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock('@/lib/services/team-notification-service', () => ({
  TeamNotificationService: {
    notifyHumanIntervention: (...args: unknown[]) => mockNotifyTeam(...args),
    getTeamMembersWithEmailNotifications: (...args: unknown[]) => mockGetTeamMembers(...args),
  },
}));
jest.mock('@/lib/services/notification-service', () => ({
  NotificationType: { WARNING: 'warning' },
  NotificationCategory: { HUMAN_INTERVENTION: 'human_intervention' },
  NotificationPriority: { LOW: 'low', NORMAL: 'normal', HIGH: 'high', URGENT: 'urgent' },
}));
jest.mock('@/lib/services/visitor-notification-service', () => ({
  VisitorNotificationService: { notifyMessageReceived: (...args: unknown[]) => mockNotifyVisitor(...args) },
}));
jest.mock('@/lib/services/whatsapp/WhatsAppSendService', () => ({
  WhatsAppSendService: { sendMessage: (...args: unknown[]) => mockSendWhatsApp(...args) },
}));
jest.mock('@/lib/services/channels/ChannelSendService', () => ({
  ChannelSendService: { sendMessage: (...args: unknown[]) => mockSendChannel(...args) },
  sanitizeZavuRecipient: (recipient: string) => recipient,
}));
jest.mock('uuid', () => ({ v4: () => '66666666-6666-4666-8666-666666666666' }));

import { NextRequest } from 'next/server';
import { randomBytes, webcrypto } from 'node:crypto';
import { POST } from '../route';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const DELIVERY_ID = '77777777-7777-4777-8777-777777777777';
const CALLER_EMAIL = 'caller@example.invalid';
const serviceCredential = randomBytes(32).toString('hex');
const originalServiceCredential = process.env.SERVICE_API_KEY;
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

type DbResult = { data: any; error: { message: string } | null };

function chain(result: DbResult | Error) {
  const query: any = {};
  for (const method of ['select', 'insert', 'eq', 'in', 'is', 'gte', 'order', 'limit']) {
    query[method] = jest.fn().mockReturnValue(query);
  }
  const settle = () => result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  query.maybeSingle = jest.fn(settle);
  query.single = jest.fn(settle);
  query.then = (resolve: (value: DbResult) => unknown, reject: (error: Error) => unknown) =>
    settle().then(resolve, reject);
  return query;
}

function mockDatabase(options: {
  conversation?: Record<string, unknown>;
  delivery?: Record<string, unknown> | null;
  deliveryError?: { message: string };
  messageResult?: DbResult | Error;
  taskResult?: DbResult | Error;
  existingTask?: 'serial' | 'recent';
} = {}) {
  const conversation = chain({
    data: {
      id: CONVERSATION_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      lead_id: LEAD_ID,
      visitor_id: null,
      channel: 'voice',
      custom_data: { phone: '+14155550100', whatsapp_phone: '+14155550100' },
      ...options.conversation,
    },
    error: null,
  });
  const messages = chain(options.messageResult || { data: null, error: null });
  const leads = chain({ data: { name: 'Test Caller', email: CALLER_EMAIL }, error: null });
  const serial = chain({ data: options.existingTask === 'serial' ? [{ id: TASK_ID }] : [], error: null });
  const recent = chain({ data: options.existingTask === 'recent' ? [{ id: TASK_ID }] : [], error: null });
  const task = chain(options.taskResult || { data: { id: TASK_ID }, error: null });
  const deliveryRow: Record<string, unknown> | null = options.delivery === null ? null : {
    id: DELIVERY_ID,
    conversation_id: CONVERSATION_ID,
    site_id: SITE_ID,
    status: 'answered',
    ended_at: null,
    zavu_call_id: 'offline-provider-call',
    ...options.delivery,
  };
  const delivery = chain({ data: null, error: null });
  // Apply the security filters rather than returning foreign/ended rows anyway.
  delivery.maybeSingle.mockImplementation(async () => ({
    data: deliveryRow && delivery.eq.mock.calls.every(([field, value]: [string, unknown]) => deliveryRow[field] === value)
      && delivery.is.mock.calls.every(([field, value]: [string, unknown]) => deliveryRow[field] === value)
      && delivery.in.mock.calls.every(([field, values]: [string, unknown[]]) => values.includes(deliveryRow[field]))
      ? deliveryRow : null,
    error: options.deliveryError || null,
  }));
  const taskQueries = [serial, recent, task];
  mockFrom.mockImplementation((table: string) => {
    if (table === 'conversations') return conversation;
    if (table === 'voice_call_deliveries') return delivery;
    if (table === 'messages') return messages;
    if (table === 'leads') return leads;
    if (table === 'tasks' && taskQueries.length) return taskQueries.shift();
    throw new Error(`Unexpected offline database query: ${table}`);
  });
  return { messages, task, serial, recent, delivery };
}

function teamResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    notificationsSent: 1,
    emailsSent: 0,
    totalMembers: 1,
    membersWithEmailEnabled: 0,
    errors: [],
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}, headers?: Record<string, string>) {
  return new NextRequest('https://backend.example.invalid/api/agents/tools/contact-human', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(headers ?? (overrides.voice_call_delivery_id !== undefined ? { 'x-api-key': serviceCredential } : {})),
    },
    body: JSON.stringify({
      conversation_id: CONVERSATION_ID,
      message: 'Please ask a human to help with this request.',
      priority: 'high',
      summary: 'Caller requested human assistance during the current call.',
      name: 'Test Caller',
      email: CALLER_EMAIL,
      ...overrides,
    }),
  });
}

function expectNoCallerContact(body: any) {
  expect(mockNotifyVisitor).not.toHaveBeenCalled();
  expect(mockSendWhatsApp).not.toHaveBeenCalled();
  expect(mockSendChannel).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(body.data).toMatchObject({
    human_joined: false,
    conversation_origin: 'voice',
    channel_response: { sent: false, type: 'none', channel: 'voice' },
    visitor_notification: { sent: false, email: CALLER_EMAIL },
  });
}

function expectNoEscalationSideEffects(db: ReturnType<typeof mockDatabase>) {
  expect(db.messages.insert).not.toHaveBeenCalled();
  expect(db.task.insert).not.toHaveBeenCalled();
  expect(mockFrom).not.toHaveBeenCalledWith('messages');
  expect(mockFrom).not.toHaveBeenCalledWith('tasks');
  expect(mockNotifyTeam).not.toHaveBeenCalled();
  expect(mockGetTeamMembers).not.toHaveBeenCalled();
  expect(mockNotifyVisitor).not.toHaveBeenCalled();
  expect(mockSendWhatsApp).not.toHaveBeenCalled();
  expect(mockSendChannel).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
}

describe('POST contact-human: offline voice escalation', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  });

  afterAll(() => {
    if (originalServiceCredential === undefined) delete process.env.SERVICE_API_KEY;
    else process.env.SERVICE_API_KEY = originalServiceCredential;
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
  });

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.SERVICE_API_KEY = serviceCredential;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Live requests are forbidden in this test'));
    mockDatabase();
    mockNotifyTeam.mockResolvedValue(teamResult());
    mockGetTeamMembers.mockResolvedValue([{ email: 'team@example.invalid' }]);
    mockNotifyVisitor.mockResolvedValue({ success: true });
    mockSendWhatsApp.mockResolvedValue({ success: true });
    mockSendChannel.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    ['direct channel', { channel: 'voice', custom_data: { channel: 'whatsapp', phone: '+14155550100' } }],
    ['custom_data.channel', { channel: null, custom_data: { channel: 'voice', phone: '+14155550100' } }],
    ['custom_data.source', { channel: null, custom_data: { source: 'voice', phone: '+14155550100' } }],
  ])('queues a voice request from %s without any caller email/WhatsApp/call fallback', async (_origin, conversation) => {
    const db = mockDatabase({ conversation: conversation as Record<string, unknown> });
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      success: true,
      data: {
        status: 'pending',
        team_notification: { accepted: true, notifications_sent: 1, emails_sent: 0 },
        support_task: { created: true, task_id: TASK_ID },
        system_message: { saved: true },
      },
    });
    expectNoCallerContact(body);
    // Eligible recipients are not evidence that any specific address was notified.
    expect(mockGetTeamMembers).not.toHaveBeenCalled();
    expect(body.data.team_notification).not.toHaveProperty('notified_emails');
    expect(mockNotifyTeam).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: CONVERSATION_ID, siteId: SITE_ID, priority: 'high',
    }));
    expect(db.task.insert).toHaveBeenCalledWith([expect.objectContaining({
      conversation_id: CONVERSATION_ID,
      lead_id: LEAD_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      status: 'pending',
      type: 'support',
    })]);
    expect(db.messages.insert).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalledWith('voice_call_deliveries');
  });

  describe('server-resolved active delivery binding', () => {
    it.each(['missing', 'incorrect', 'forged identity'])('rejects a %s service credential before looking up a delivery', async credentialKind => {
      const db = mockDatabase({ conversation: { channel: 'web' } });
      const headers: Record<string, string> = credentialKind === 'incorrect'
        ? { 'x-api-key': randomBytes(32).toString('hex') }
        : credentialKind === 'forged identity'
          ? { 'x-api-key-data': JSON.stringify({ internal: true, service: true }), 'x-auth-validated': 'true' }
          : {};

      const response = await POST(request({ voice_call_delivery_id: DELIVERY_ID }, headers));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
      expect(mockFrom).not.toHaveBeenCalled();
      expectNoEscalationSideEffects(db);
      const output = JSON.stringify([body, (console.error as jest.Mock).mock.calls, (console.log as jest.Mock).mock.calls]);
      expect(output).not.toContain(serviceCredential);
      if (headers['x-api-key']) expect(output).not.toContain(headers['x-api-key']);
    });

    it('requires a configured service credential instead of trusting a marker alone', async () => {
      const db = mockDatabase();
      delete process.env.SERVICE_API_KEY;

      const response = await POST(request({ voice_call_delivery_id: DELIVERY_ID }));

      expect(response.status).toBe(403);
      expect(mockFrom).not.toHaveBeenCalled();
      expectNoEscalationSideEffects(db);
    });

    it('accepts a verified bearer service credential through the existing helper', async () => {
      mockDatabase({ conversation: { channel: 'web' } });

      const response = await POST(request({ voice_call_delivery_id: DELIVERY_ID }, {
        authorization: `Bearer ${serviceCredential}`,
      }));

      expect(response.status).toBe(202);
      expectNoCallerContact(await response.json());
    });

    it.each(['web', 'whatsapp', 'email'])('keeps an outbound call on a reused %s conversation in the voice-only path', async channel => {
      const db = mockDatabase({ conversation: { channel } });

      const response = await POST(request({ voice_call_delivery_id: DELIVERY_ID }));
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toMatchObject({ success: true, data: { status: 'pending' } });
      expectNoCallerContact(body);
      expect(db.delivery.eq).toHaveBeenCalledWith('id', DELIVERY_ID);
      expect(db.delivery.eq).toHaveBeenCalledWith('conversation_id', CONVERSATION_ID);
      expect(db.delivery.eq).toHaveBeenCalledWith('site_id', SITE_ID);
      expect(db.delivery.in).toHaveBeenCalledWith('status', ['initiated', 'ringing', 'answered', 'in_progress']);
      expect(db.delivery.is).toHaveBeenCalledWith('ended_at', null);
      expect(db.messages.insert).toHaveBeenCalledTimes(1);
      expect(db.task.insert).toHaveBeenCalledTimes(1);
      expect(mockNotifyTeam).toHaveBeenCalledTimes(1);
      expect(mockGetTeamMembers).not.toHaveBeenCalled();
    });

    it.each(['initiated', 'ringing', 'answered', 'in_progress'])('allows active delivery status %s', async status => {
      mockDatabase({ conversation: { channel: 'web' }, delivery: { status } });

      const response = await POST(request({ voice_call_delivery_id: DELIVERY_ID }));

      expect(response.status).toBe(202);
      expectNoCallerContact(await response.json());
    });

    it.each(['not-a-uuid', '', null, 123, {}, [DELIVERY_ID]])('rejects malformed delivery ID %j before any reads or side effects', async deliveryId => {
      const db = mockDatabase({ conversation: { channel: 'whatsapp' } });

      const response = await POST(request({ voice_call_delivery_id: deliveryId }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ success: false, error: { code: 'INVALID_REQUEST' } });
      expect(mockFrom).not.toHaveBeenCalled();
      expectNoEscalationSideEffects(db);
    });

    it.each([
      ['missing', null],
      ['foreign site', { site_id: USER_ID }],
      ['different conversation', { conversation_id: USER_ID }],
      ['different delivery', { id: USER_ID }],
      ['ended', { ended_at: '2026-10-01T12:00:00.000Z' }],
      ['completed', { status: 'completed' }],
      ['failed', { status: 'failed' }],
      ['not yet placed', { status: 'placing' }],
      ['missing provider call', { zavu_call_id: null }],
      ['blank provider call', { zavu_call_id: ' ' }],
    ] as Array<[string, Record<string, unknown> | null]>)('rejects a %s delivery without falling back to caller contact', async (_label, delivery) => {
      const db = mockDatabase({ conversation: { channel: 'whatsapp' }, delivery });

      const response = await POST(request({ voice_call_delivery_id: DELIVERY_ID }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        success: false, error: { code: 'VOICE_CALL_BINDING_INVALID' },
      });
      expectNoEscalationSideEffects(db);
    });

    it('does not let a voice conversation bypass an explicitly invalid delivery binding', async () => {
      const db = mockDatabase({ delivery: null });

      const response = await POST(request({ voice_call_delivery_id: DELIVERY_ID }));

      expect(response.status).toBe(409);
      expectNoEscalationSideEffects(db);
    });

    it('requires the conversation tenant before querying the delivery', async () => {
      const db = mockDatabase({ conversation: { channel: 'web', site_id: null } });

      const response = await POST(request({ voice_call_delivery_id: DELIVERY_ID }));

      expect(response.status).toBe(409);
      expect(mockFrom).not.toHaveBeenCalledWith('voice_call_deliveries');
      expectNoEscalationSideEffects(db);
    });

    it('fails closed on a delivery lookup error before any side effects', async () => {
      const db = mockDatabase({
        conversation: { channel: 'email' }, deliveryError: { message: 'Offline lookup failure' },
      });

      const response = await POST(request({ voice_call_delivery_id: DELIVERY_ID }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ success: false, error: { code: 'DATABASE_ERROR' } });
      expectNoEscalationSideEffects(db);
    });
  });

  describe('bounded team notification wait', () => {
    it('returns pending within 2 seconds when a task persisted but the notifier never settles', async () => {
      jest.useFakeTimers();
      const db = mockDatabase();
      mockNotifyTeam.mockImplementation(() => new Promise(() => {}));
      let finished = false;
      const pendingResponse = POST(request()).then(response => { finished = true; return response; });

      await jest.advanceTimersByTimeAsync(1_999);
      expect(db.task.insert).toHaveBeenCalledTimes(1);
      expect(finished).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      const response = await pendingResponse;
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toMatchObject({
        success: true,
        data: {
          status: 'pending',
          support_task: { created: true, task_id: TASK_ID },
          team_notification: { accepted: false, timed_out: true, notifications_sent: 0, emails_sent: 0 },
        },
      });
      expect(mockAfter).toHaveBeenCalledTimes(1);
      expectNoCallerContact(body);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not claim acceptance on timeout without a durable task', async () => {
      jest.useFakeTimers();
      mockDatabase({ conversation: { lead_id: null } });
      mockNotifyTeam.mockImplementation(() => new Promise(() => {}));

      const pendingResponse = POST(request());
      await jest.advanceTimersByTimeAsync(2_000);
      const response = await pendingResponse;
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        success: false,
        data: {
          status: 'failed',
          support_task: { created: false },
          team_notification: { accepted: false, timed_out: true },
        },
      });
      expectNoCallerContact(body);
    });

    it('keeps a late rejected notification handled by the after continuation', async () => {
      jest.useFakeTimers();
      let rejectNotification!: (error: Error) => void;
      mockNotifyTeam.mockReturnValue(new Promise((_resolve, reject) => { rejectNotification = reject; }));

      const pendingResponse = POST(request());
      await jest.advanceTimersByTimeAsync(2_000);
      const response = await pendingResponse;
      expect(response.status).toBe(202);
      const continuation = mockAfter.mock.calls[0][0]();
      rejectNotification(new Error('Offline late rejection'));
      await expect(continuation).resolves.toBeUndefined();
      expect(mockNotifyTeam).toHaveBeenCalledTimes(1);
    });

    it('does not hide an accepted task if after cannot register outside a request lifecycle', async () => {
      jest.useFakeTimers();
      mockAfter.mockImplementation(() => { throw new Error('Offline lifecycle missing'); });
      mockNotifyTeam.mockImplementation(() => new Promise(() => {}));

      const pendingResponse = POST(request());
      await jest.advanceTimersByTimeAsync(2_000);
      const response = await pendingResponse;

      expect(response.status).toBe(202);
      expectNoCallerContact(await response.json());
    });

    it('clears the wait timer when notification acceptance arrives before the deadline', async () => {
      jest.useFakeTimers();

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body.data.team_notification).toMatchObject({ accepted: true, timed_out: false });
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it.each(['failure', 'no recipients', 'exception'])('remains pending with a durable task despite notification %s and a failed audit insert', async failure => {
    mockDatabase({ messageResult: { data: null, error: { message: 'Offline insert failure' } } });
    if (failure === 'exception') {
      mockNotifyTeam.mockRejectedValue(new Error('Offline notification failure'));
    } else {
      mockNotifyTeam.mockResolvedValue(teamResult({
        success: failure === 'no recipients', notificationsSent: 0, totalMembers: 0,
      }));
    }

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      success: true,
      data: {
        status: 'pending',
        team_notification: { accepted: false, notifications_sent: 0, emails_sent: 0 },
        support_task: { created: true, task_id: TASK_ID },
        system_message: { saved: false },
      },
    });
    expectNoCallerContact(body);
  });

  it.each([
    { success: true, notificationsSent: 1, emailsSent: 0 },
    { success: true, notificationsSent: 0, emailsSent: 1 },
    // notifyTeam can catch a later error after already persisting/sending some notifications.
    { success: false, notificationsSent: 1, emailsSent: 0 },
    { success: false, notificationsSent: 0, emailsSent: 1 },
  ])('uses actual team acceptance, not its aggregate success flag: %j', async notification => {
    mockDatabase({
      messageResult: new Error('Offline audit insert rejection'),
      taskResult: { data: null, error: { message: 'Offline task insert failure' } },
    });
    mockNotifyTeam.mockResolvedValue(teamResult(notification));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      success: true,
      data: {
        status: 'pending',
        team_notification: { accepted: true },
        support_task: { created: false, task_id: null },
        system_message: { saved: false },
      },
    });
    expectNoCallerContact(body);
  });

  it.each(['serial', 'recent'] as const)('accepts a durable deduplicated task by %s even with no team recipients', async existingTask => {
    const db = mockDatabase({ existingTask });
    mockNotifyTeam.mockResolvedValue(teamResult({ notificationsSent: 0, totalMembers: 0 }));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ success: true, data: { status: 'pending', support_task: { task_id: TASK_ID } } });
    expect(db.task.insert).not.toHaveBeenCalled();
    expectNoCallerContact(body);
  });

  it('returns failure when notification, audit message, and task all fail', async () => {
    mockDatabase({
      messageResult: { data: null, error: { message: 'Offline message failure' } },
      taskResult: { data: null, error: { message: 'Offline task failure' } },
    });
    mockNotifyTeam.mockResolvedValue(teamResult({ success: false, notificationsSent: 0 }));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      error: { code: 'HUMAN_INTERVENTION_UNAVAILABLE' },
      data: {
        status: 'failed',
        team_notification: { accepted: false },
        support_task: { created: false, task_id: null },
        system_message: { saved: false },
      },
    });
    expectNoCallerContact(body);
  });

  it.each([0, 2])('does not confuse success=true/%i recipients or a saved audit message with a queued escalation', async totalMembers => {
    mockDatabase({ conversation: { lead_id: null } });
    mockNotifyTeam.mockResolvedValue(teamResult({ notificationsSent: 0, totalMembers }));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      data: {
        status: 'failed',
        team_notification: { accepted: false },
        support_task: { created: false, task_id: null },
        system_message: { saved: true },
      },
    });
    expect(mockFrom).not.toHaveBeenCalledWith('tasks');
    expectNoCallerContact(body);
  });

  it('returns failure when writes reject and no task row is returned', async () => {
    mockDatabase({
      messageResult: new Error('Offline message rejection'),
      taskResult: { data: null, error: null },
    });
    mockNotifyTeam.mockRejectedValue(new Error('Offline notification rejection'));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      data: { status: 'failed', support_task: { created: false }, system_message: { saved: false } },
    });
    expectNoCallerContact(body);
  });

  it.each([
    ['web', 'email_fallback'],
    ['email', 'email'],
    ['whatsapp', 'whatsapp'],
  ])('preserves the existing %s caller response', async (channel, responseType) => {
    mockDatabase({ conversation: { channel } });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      success: true,
      data: {
        status: 'pending',
        conversation_origin: channel,
        channel_response: { sent: true, type: responseType, channel },
      },
    });
    expect(mockGetTeamMembers).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalledWith('voice_call_deliveries');
    if (channel === 'whatsapp') {
      expect(mockSendWhatsApp).toHaveBeenCalledTimes(1);
      expect(mockNotifyVisitor).not.toHaveBeenCalled();
    } else {
      expect(mockNotifyVisitor).toHaveBeenCalledTimes(1);
      expect(mockSendWhatsApp).not.toHaveBeenCalled();
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('leaves the legacy non-voice result unchanged when no escalation was accepted', async () => {
    mockDatabase({
      conversation: { channel: 'web', lead_id: null },
      messageResult: { data: null, error: { message: 'Offline message failure' } },
    });
    mockNotifyTeam.mockResolvedValue(teamResult({ success: false, notificationsSent: 0 }));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ success: true, data: { status: 'pending' } });
    expect(mockNotifyVisitor).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});