import { describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

type Row = Record<string, any>;
type AsyncMock = (...args: any[]) => Promise<any>;
const scope = { instanceId: 'instance', siteId: 'site', userId: 'user', userMessageLogId: 'action-1', messageSid: 'image-sid' };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const pathValue = (row: Row, key: string) => key.split(/->>?/).reduce((value, part) => value?.[part], row);

function database(rows: Row[] = []) {
  let beforeUpdate: (() => void) | undefined;
  const staticRows: Record<string, any> = {
    sites: [{ id: 'site', name: 'Test site' }], site_members: [],
    remote_sessions: { site_id: 'site', instance_id: 'instance' }, remote_instances: { status: 'running' },
  };
  const writes: Row[] = [];
  const filters: Array<[string, any]> = [];
  const db = {
    rpc: jest.fn<AsyncMock>().mockResolvedValue({ data: [{ id: 'user' }], error: null }),
    from: jest.fn((table: string) => {
      if (table !== 'instance_logs' && !Object.hasOwn(staticRows, table)) throw new Error(`Unexpected table ${table}`);
      const conditions: Array<(row: Row) => boolean> = [];
      const order: string[] = [];
      let patch: Row | undefined;
      let insert: Row | undefined;
      let count = Infinity;
      let single = false;
      const q: any = {};
      q.select = () => q;
      q.eq = (key: string, value: any) => {
        filters.push([key, value]);
        conditions.push(row => key === 'details' ? JSON.stringify(row.details) === value : pathValue(row, key) === value);
        return q;
      };
      q.in = (key: string, values: any[]) => { conditions.push(row => values.includes(pathValue(row, key))); return q; };
      q.order = (key: string) => { order.push(key); return q; };
      q.limit = (n: number) => { count = n; return q; };
      q.single = q.maybeSingle = () => { single = true; return q; };
      q.update = (value: Row) => { patch = clone(value); return q; };
      q.insert = (value: Row) => { insert = clone(value); return q; };
      q.then = (resolve: any, reject: any) => Promise.resolve().then(() => {
        if (table !== 'instance_logs') return { data: staticRows[table], error: null };
        if (insert) {
          const row = { ...insert, id: `action-${rows.length + 1}`, created_at: rows.length + 1 };
          rows.push(row);
          return { data: clone(single ? row : [row]), error: null };
        }
        if (patch && beforeUpdate) { const callback = beforeUpdate; beforeUpdate = undefined; callback(); }
        const matches = rows.filter(row => conditions.every(condition => condition(row))).sort((a, b) => {
          for (const key of order) { if (a[key] !== b[key]) return a[key] > b[key] ? -1 : 1; }
          return 0;
        }).slice(0, count);
        if (patch) for (const row of matches) { writes.push(clone(patch)); Object.assign(row, clone(patch)); }
        return { data: clone(single ? matches[0] ?? null : matches), error: null };
      }).then(resolve, reject);
      return q;
    }),
  };
  return { db, rows, writes, filters, beforeUpdate: (callback: () => void) => { beforeUpdate = callback; } };
}

function actionRow(details: Row = {}) {
  return { id: scope.userMessageLogId, instance_id: scope.instanceId, site_id: scope.siteId, user_id: scope.userId,
    log_type: 'user_action', trusted_user_action: true, message: 'pending', created_at: 1,
    details: { status: 'running', message_sid: scope.messageSid, whatsapp_media: { status: 'pending' }, ...details } };
}

function actionHelpers(db: any) {
  return loadRuntimeModule<typeof import('../inbound-action')>('src/app/api/agents/gear/whatsapp/webhook/inbound-action.ts', {
    '@/lib/database/supabase-client': { supabaseAdmin: db },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('registered WhatsApp durable media admission', () => {
  it.each([
    { contentType: 'image/png', supersededBeforeFirstGuard: false },
    { contentType: 'audio/ogg', supersededBeforeFirstGuard: false },
    { contentType: 'image/png', supersededBeforeFirstGuard: true },
  ])('admits slow media before text without late restart: $contentType / early supersession=$supersededBeforeFirstGuard', async ({ contentType, supersededBeforeFirstGuard }) => {
    const h = database();
    const helpers = actionHelpers(h.db);
    const entered = deferred<void>();
    const release = deferred<void>();
    const admitted = deferred<void>();
    const initialGuard = deferred<void>();
    const mediaUrl = 'https://media.example.invalid/original';
    const finalUrl = 'https://assets.example.invalid/uploaded';
    const service = jest.fn<AsyncMock>().mockImplementation(async () => {
      expect(h.rows).toHaveLength(supersededBeforeFirstGuard ? 2 : 1);
      expect(h.rows[0].details.whatsapp_media.status).toBe('pending');
      expect(h.rows[0].message).not.toContain(mediaUrl);
      expect(h.rows[0].message).toContain('Do not guess or substitute');
      entered.resolve();
      await release.promise;
      return { success: true, files: [{ originalUrl: mediaUrl, url: finalUrl,
        ...(contentType.startsWith('audio/') ? { transcription: 'Use the blue version' } : {}) }] };
    });
    const media = loadRuntimeModule<typeof import('../inbound-media')>('src/app/api/agents/gear/whatsapp/webhook/inbound-media.ts', {
      '@/lib/services/twilio/TwilioMediaTaskService': { handleTwilioMediaAndCreateTask: service },
    });
    const userLogs = loadRuntimeModule<typeof import('@/app/api/robots/instance/assistant/user-message-log')>(
      'src/app/api/robots/instance/assistant/user-message-log.ts', { '@/lib/database/supabase-client': { supabaseAdmin: h.db } },
    );
    const authenticateGearWebhook = jest.fn<AsyncMock>()
      .mockResolvedValueOnce({ ok: true, claim: { eventId: 'image-sid' }, webhookData: {
        From: 'whatsapp:+15555550100', To: 'whatsapp:+15555550101', MessageSid: 'image-sid', Body: '',
        NumMedia: '1', MediaUrl0: mediaUrl, MediaContentType0: contentType,
      } })
      .mockResolvedValueOnce({ ok: true, claim: { eventId: 'text-sid' }, webhookData: {
        From: 'whatsapp:+15555550100', To: 'whatsapp:+15555550101', MessageSid: 'text-sid', Body: 'Edit that attachment', NumMedia: '0',
      } });
    const reset = jest.fn<AsyncMock>().mockResolvedValue(undefined);
    const start = jest.fn<AsyncMock>().mockImplementation(async (_workflow, [input]) => {
      // Snapshot used by later text is explicitly pending; no hidden wait or substitute asset.
      expect(input.systemPrompt).toContain('"image-sid": pending');
      expect(input.systemPrompt).toContain('Do not infer their contents or substitute another recent image/asset');
      return { runId: 'run' };
    });
    const route = loadRuntimeModule<typeof import('../route')>('src/app/api/agents/gear/whatsapp/webhook/route.ts', {
      'next/server': { NextResponse }, '@/lib/database/supabase-client': { supabaseAdmin: h.db },
      'workflow/api': { start }, '../workflow': { runGearAgentWorkflow: jest.fn(), runUnregisteredGearAgentWorkflow: jest.fn() },
      '@/lib/services/requirement-cron-reset': { resetRequirementOnUserAction: reset },
      '@/app/api/robots/instance/assistant/user-message-log': { ...userLogs, insertUserActionLog: async (params: any) => {
        const result = await userLogs.insertUserActionLog(params);
        if (params.details.message_sid === 'image-sid' && supersededBeforeFirstGuard) {
          admitted.resolve();
          await initialGuard.promise;
        }
        return result;
      } },
      '@/lib/utils/phone-normalizer': { normalizePhoneForStorage: (p: string) => p, normalizePhoneForSearch: (p: string) => [p] },
      '@/lib/services/ai/transcribeAudio': {},
      './twilio-webhook-auth': { authenticateGearWebhook, finishGearWebhookClaim: jest.fn<AsyncMock>().mockResolvedValue(undefined) },
      './reply-context': { resolveWhatsAppReplyContext: jest.fn<AsyncMock>().mockResolvedValue('') },
      './inbound-action': helpers,
      './inbound-media': { ...media, prepareRegisteredWhatsAppMedia: (params: any) => media.prepareRegisteredWhatsAppMedia({
        ...params, accountSid: randomBytes(16).toString('hex'), authToken: randomBytes(32).toString('hex'),
      }) },
    });
    const request = () => new NextRequest('https://example.invalid/webhook', { method: 'POST' });
    const oldRequest = route.POST(request());
    await (supersededBeforeFirstGuard ? admitted.promise : entered.promise);
    expect((await route.POST(request())).status).toBe(200);
    if (supersededBeforeFirstGuard) {
      initialGuard.resolve();
      await entered.promise;
    }
    expect(h.rows.map(row => row.details.message_sid)).toEqual(['image-sid', 'text-sid']);
    const oldCreatedAt = h.rows[0].created_at;
    release.resolve();
    expect((await oldRequest).status).toBe(200);
    expect(h.rows).toHaveLength(2);
    expect(h.rows[0].created_at).toBe(oldCreatedAt);
    expect(h.rows[0].details.status).toBe('running');
    expect(h.rows[0].details.whatsapp_media.status).toBe('ready');
    expect(h.rows[0].message).toContain(finalUrl);
    if (contentType.startsWith('audio/')) expect(h.rows[0].message).toContain('Use the blue version');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1][0].userMessageLogId).toBe('action-2');
    expect(reset.mock.calls).toEqual(supersededBeforeFirstGuard
      ? [['instance', 'action-2']] : [['instance', 'action-1'], ['instance', 'action-2']]);
    expect(service).toHaveBeenCalledTimes(1);
  });

  it('CAS retries without dropping concurrent cancellation/requirement tags', async () => {
    const h = database([actionRow()]);
    h.beforeUpdate(() => { Object.assign(h.rows[0].details, { status: 'stopped', requirement_id: 'requirement' }); });
    expect(await actionHelpers(h.db).finalizeWhatsAppAction(scope, 'ready', { status: 'ready', items: [] })).toBe(true);
    expect(h.rows[0].details).toEqual(expect.objectContaining({ status: 'stopped', requirement_id: 'requirement' }));
    expect(h.writes).toHaveLength(1);
    expect(h.filters).toEqual(expect.arrayContaining([
      ['id', 'action-1'], ['instance_id', 'instance'], ['site_id', 'site'], ['user_id', 'user'],
      ['trusted_user_action', true], ['log_type', 'user_action'], ['details->>message_sid', 'image-sid'],
    ]));
  });

  it('does not overwrite recovery initialized during finalization', async () => {
    const h = database([actionRow()]);
    const recovery = { revision: 'new-revision', respawnCount: 1, lease_token: randomBytes(16).toString('hex') };
    h.beforeUpdate(() => { h.rows[0].details.assistant_recovery = recovery; });
    expect(await actionHelpers(h.db).finalizeWhatsAppAction(scope, 'ready')).toBe(false);
    expect(h.rows[0].details.assistant_recovery).toEqual(recovery);
    expect(h.rows[0].message).toBe('pending');
    expect(h.writes).toHaveLength(0);
  });

  it.each(['site_id', 'instance_id', 'user_id', 'trusted_user_action'])('cannot enrich another scope (%s)', async key => {
    const row: Row = actionRow();
    row[key] = key === 'trusted_user_action' ? false : 'foreign';
    const h = database([row]);
    expect(await actionHelpers(h.db).finalizeWhatsAppAction(scope, 'ready')).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  it('includes unresolved media from another authorized member of the same instance, never another site', async () => {
    const h = database([actionRow(), { ...actionRow(), id: 'shared', user_id: 'other-member',
      details: { message_sid: 'shared-image', whatsapp_media: { status: 'failed' } } },
    { ...actionRow(), id: 'foreign', site_id: 'foreign', details: { message_sid: 'foreign-image', whatsapp_media: { status: 'pending' } } }]);
    const context = await actionHelpers(h.db).unresolvedWhatsAppMediaContext(scope);
    expect(context).toContain('shared-image');
    expect(context).not.toContain('foreign-image');
  });
});

describe('registered media availability evidence', () => {
  function prepare(service: AsyncMock) {
    const handle = jest.fn<AsyncMock>().mockImplementation(service);
    const helper = loadRuntimeModule<typeof import('../inbound-media')>('src/app/api/agents/gear/whatsapp/webhook/inbound-media.ts', {
      '@/lib/services/twilio/TwilioMediaTaskService': { handleTwilioMediaAndCreateTask: handle },
    });
    const first = 'https://media.example.invalid/first';
    const second = 'https://media.example.invalid/second';
    const params = { instanceId: 'instance', siteId: 'site', userId: 'user', messageSid: 'message',
      accountSid: randomBytes(16).toString('hex'), authToken: randomBytes(32).toString('hex'),
      message: `First: ${first}\nSecond: ${second}`,
      media: [{ url: first, contentType: 'image/png' }, { url: second, contentType: 'audio/ogg' }] };
    return { helper, params, handle, first, second };
  }

  it('preserves exact media index on partial success and marks absent voice transcription', async () => {
    const h = prepare(async () => ({ success: true, files: [{ originalUrl: 'https://media.example.invalid/second',
      url: 'https://assets.example.invalid/second' }] }));
    const result = await h.helper.prepareRegisteredWhatsAppMedia(h.params);
    expect(result.media).toEqual({ status: 'partial', items: [
      { index: 0, contentType: 'image/png', status: 'failed' },
      { index: 1, contentType: 'audio/ogg', status: 'ready', transcription: 'failed' },
    ] });
    expect(result.message).toContain('First: [media failed: message, attachment 1; unavailable]');
    expect(result.message).toContain('Second: https://assets.example.invalid/second');
    expect(result.message).toContain('Voice transcription failed');
    expect(result.message).not.toContain(h.first);
    expect(result.message).not.toContain(h.second);
    expect(result.message).not.toContain('media ready');
  });

  it.each(['missing_credentials', 'exception', 'empty_success'])('persists failure without inaccessible URLs or success claims: %s', async mode => {
    const h = prepare(async () => {
      if (mode === 'exception') throw new Error('offline failure');
      return { success: true, files: [] };
    });
    const result = await h.helper.prepareRegisteredWhatsAppMedia({ ...h.params,
      ...(mode === 'missing_credentials' ? { authToken: undefined } : {}) });
    expect(result.media.status).toBe('failed');
    expect(result.message).toContain('Do not guess or substitute another image/asset');
    expect(result.message).not.toContain(h.first);
    expect(result.message).not.toContain(h.second);
    expect(result.message).not.toContain('media ready');
    if (mode === 'missing_credentials') expect(h.handle).not.toHaveBeenCalled();
  });
});