import { describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

type AsyncMock = (...args: any[]) => Promise<any>;
const accessPath = '@/lib/services/channels/agent-project-access';
const sessionPath = '@/lib/services/channels/agent-project-session';

function setup(allowed: string[], sessionSite = 'suspended', sessionUser = 'user') {
  const projects = ['suspended', 'active', 'other'].map(id => ({ id, name: id }));
  const writes: any[] = [];
  const sessions = new Map<string, any>(['+15555550100', 'email:user@example.invalid'].map(key => [key, {
    phone_number: key, user_id: sessionUser, site_id: sessionSite, instance_id: 'old-instance',
  }]));
  let sessionError: any = null;
  const rpc = jest.fn<AsyncMock>().mockImplementation(async (name, args) => name === 'get_user_by_phone'
    ? { data: [{ id: 'user' }], error: null }
    : { data: allowed.includes(args.p_site_id), error: null });
  const db = {
    rpc,
    from: jest.fn((table: string) => {
      let lobby = false;
      let key: string | undefined;
      let patch: any;
      const sessionColumns = ['user_id', 'site_id', 'instance_id', 'phone_number'];
      const q: any = {};
      for (const method of ['single', 'maybeSingle', 'neq', 'order', 'limit']) q[method] = () => q;
      q.select = (columns: string) => {
        if (table === 'remote_sessions') for (const column of columns.split(',').map(value => value.trim())) {
          if (!sessionColumns.includes(column)) throw new Error(`Unknown session column: ${column}`);
        }
        return q;
      };
      q.eq = (column: string, value: string) => {
        if (table === 'remote_sessions') {
          if (column !== 'phone_number') throw new Error(`Unknown session filter: ${column}`);
          key = value;
        }
        return q;
      };
      q.ilike = () => { lobby = true; return q; };
      q.upsert = (value: any, options: any) => {
        if (table !== 'remote_sessions' || options?.onConflict !== 'phone_number' || !value.phone_number) {
          throw new Error('Session requires its real unique phone_number key');
        }
        for (const column of Object.keys(value)) if (!sessionColumns.includes(column)) throw new Error(`Unknown session column: ${column}`);
        key = value.phone_number;
        patch = value;
        return q;
      };
      q.then = (resolve: any, reject: any) => {
        if (table === 'remote_sessions' && patch && !sessionError) {
          sessions.set(key!, patch);
          writes.push(patch);
        }
        const data = table === 'sites' ? lobby ? { id: 'lobby' } : projects
          : table === 'site_members' ? [{ sites: projects[0] }]
          : table === 'profiles' ? [{ id: 'user' }]
          : table === 'remote_sessions' ? sessions.get(key!) ?? null
          : table === 'remote_instances' ? [{ id: 'new-instance' }]
          : null;
        return Promise.resolve({ data, error: table === 'remote_sessions' ? sessionError : null }).then(resolve, reject);
      };
      return q;
    }),
  };
  const access = loadRuntimeModule<typeof import('@/lib/services/channels/agent-project-access')>(
    'src/lib/services/channels/agent-project-access.ts', { '@/lib/database/supabase-client': { supabaseAdmin: db } });
  const sessionStore = loadRuntimeModule<typeof import('@/lib/services/channels/agent-project-session')>(
    'src/lib/services/channels/agent-project-session.ts', { '@/lib/database/supabase-client': { supabaseAdmin: db } });
  const start = jest.fn<AsyncMock>().mockResolvedValue({ runId: 'run' });
  const registered = jest.fn();
  const lobby = jest.fn();
  const insert = jest.fn<AsyncMock>().mockResolvedValue({ id: 'action' });
  const common = {
    '@/lib/database/supabase-client': { supabaseAdmin: db }, [accessPath]: access, [sessionPath]: sessionStore,
    'workflow/api': { start },
    '@/lib/services/requirement-cron-reset': { resetRequirementOnUserAction: jest.fn<AsyncMock>() },
    '@/app/api/robots/instance/assistant/user-message-log': { insertUserActionLog: insert },
  };
  const email = loadRuntimeModule<typeof import('@/app/api/agents/gear/email/handler')>(
    'src/app/api/agents/gear/email/handler.ts', {
      ...common, './workflow': { runGearEmailWorkflow: registered, runUnregisteredGearEmailWorkflow: lobby },
    });
  const whatsapp = loadRuntimeModule<typeof import('../route')>('src/app/api/agents/gear/whatsapp/webhook/route.ts', {
    ...common, 'next/server': { NextResponse },
    '../workflow': { runGearAgentWorkflow: registered, runUnregisteredGearAgentWorkflow: lobby },
    '@/lib/utils/phone-normalizer': { normalizePhoneForStorage: (p: string) => p, normalizePhoneForSearch: (p: string) => [p] },
    '@/lib/services/ai/transcribeAudio': {}, './reply-context': { resolveWhatsAppReplyContext: async () => '' },
    './inbound-media': {},
    './inbound-action': { isCurrentWhatsAppAction: async () => true, finalizeWhatsAppAction: async () => true,
      unresolvedWhatsAppMediaContext: async () => '' },
    './twilio-webhook-auth': { authenticateGearWebhook: async () => ({ ok: true, claim: {}, webhookData: {
      From: 'whatsapp:+15555550100', To: 'whatsapp:+15555550101', MessageSid: 'sid', Body: 'Hola', NumMedia: '0',
    } }), finishGearWebhookClaim: async () => {} },
  });
  const tools = loadRuntimeModule<typeof import('@/app/api/agents/tools/instance_project/assistantProtocol')>(
    'src/app/api/agents/tools/instance_project/assistantProtocol.ts', {
      [accessPath]: access, [sessionPath]: sessionStore,
    });
  const tool = tools.instanceProjectTool('user', '+15555550100');
  return { access, tool, sessionStore, tools, rpc, writes, start, registered, lobby, insert,
    failSession: () => { sessionError = { code: 'unavailable' }; },
    clearSessions: () => sessions.clear(),
    run: async (channel: string) => channel === 'email'
      ? email.handleGearEmailWebhook({ body: 'Hola', message_id: 'sid' }, 'user@example.invalid')
      : whatsapp.POST(new NextRequest('https://example.invalid/webhook', { method: 'POST' })),
  };
}

describe.each(['whatsapp', 'email'])('%s agent project routing', channel => {
  it('allows a first-time session to select its only available project', async () => {
    const h = setup(['active']);
    h.clearSessions();
    await h.run(channel);
    expect(h.start).toHaveBeenCalledWith(h.registered, [expect.objectContaining({ siteId: 'active' })]);
    expect(h.writes[0]).toMatchObject({ phone_number: channel === 'email' ? 'email:user@example.invalid' : '+15555550100',
      site_id: 'active', instance_id: null });
  });

  it('persists lobby selection and routes the next message to that project', async () => {
    const h = setup(['active', 'other']);
    await h.run(channel);
    expect(h.start).toHaveBeenCalledWith(h.lobby, [expect.objectContaining({ siteId: 'lobby' })]);
    const identity = channel === 'email' ? ' USER@EXAMPLE.INVALID ' : '+15555550100';
    const tool = h.tools.instanceProjectTool('user', identity);
    expect(await tool.execute({ action: 'set', site_id: 'other' })).toMatchObject({ success: true });
    h.start.mockClear();
    await h.run(channel);
    expect(h.start).toHaveBeenCalledWith(h.registered, [expect.objectContaining({ siteId: 'other', instanceId: 'new-instance' })]);
    expect(h.writes[0]).toMatchObject({ phone_number: channel === 'email' ? 'email:user@example.invalid' : identity,
      site_id: 'other', instance_id: null });
  });

  it('does not start work when reading the session fails', async () => {
    const h = setup(['active']);
    h.failSession();
    if (channel === 'email') await expect(h.run(channel)).rejects.toThrow('session unavailable');
    else expect(await h.run(channel)).toMatchObject({ status: 500 });
    expect(h.start).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it('preserves a currently authorized saved project and its instance', async () => {
    const h = setup(['active', 'other'], 'active');
    await h.run(channel);
    expect(h.start).toHaveBeenCalledWith(h.registered, [expect.objectContaining({ siteId: 'active', instanceId: 'old-instance' })]);
    expect(h.writes).toEqual([]);
  });

  it('routes a suspended saved project to the lobby when multiple authorized projects remain', async () => {
    const h = setup(['active', 'other']);
    await h.run(channel);
    expect(h.start).toHaveBeenCalledWith(h.lobby, [expect.objectContaining({ siteId: 'lobby', userId: 'user',
      systemPrompt: expect.stringContaining('ask which one') })]);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it('selects the only authorized project and drops the old instance', async () => {
    const h = setup(['active']);
    await h.run(channel);
    expect(h.writes[0]).toMatchObject({ site_id: 'active', user_id: 'user', instance_id: null });
    expect(h.start).toHaveBeenCalledWith(h.registered, [expect.objectContaining({ siteId: 'active', instanceId: 'new-instance' })]);
  });

  it('uses the lobby instead of an unavailable project when no authorized projects remain', async () => {
    const h = setup([]);
    await h.run(channel);
    expect(h.start).toHaveBeenCalledWith(h.lobby, [expect.objectContaining({ siteId: 'lobby',
      systemPrompt: expect.stringContaining('no currently accessible projects') })]);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('does not change projects on an authorization outage', async () => {
    const h = setup(['active']);
    h.rpc.mockImplementation(async (name) => name === 'get_user_by_phone'
      ? { data: [{ id: 'user' }], error: null } : { data: null, error: { code: 'unavailable' } });
    if (channel === 'email') await expect(h.run(channel)).rejects.toThrow('authorization unavailable');
    else expect(await h.run(channel)).toMatchObject({ status: 500 });
    expect(h.start).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});

describe('agent project authorization', () => {
  it('throws on session write failures rather than silently continuing', async () => {
    const h = setup(['active']);
    h.failSession();
    await expect(h.sessionStore.saveAgentProjectSession('user@example.invalid', 'user', 'active', null))
      .rejects.toThrow('Failed to update active project');
    expect(h.writes).toEqual([]);
  });

  it('does not claim selection succeeded when persisting the session fails', async () => {
    const h = setup(['active']);
    h.failSession();
    expect(await h.tool.execute({ action: 'set', site_id: 'active' })).toMatchObject({ success: false });
    expect(h.writes).toEqual([]);
  });

  it('never uses a model-supplied email to overwrite a different channel session', async () => {
    const h = setup(['active']);
    const tool = h.tools.instanceProjectTool('user');
    expect(await tool.execute({ action: 'set', site_id: 'active', email: 'other@example.invalid' }))
      .toMatchObject({ success: false });
    expect(h.writes).toEqual([]);
  });

  it('uses normalized namespaced email keys without colliding with WhatsApp keys', () => {
    const h = setup(['active']);
    expect(h.sessionStore.agentProjectSessionKey(' User@Example.Invalid ')).toBe('email:user@example.invalid');
    expect(h.sessionStore.agentProjectSessionKey('+15555550100')).toBe('+15555550100');
    expect(() => h.sessionStore.agentProjectSessionKey(' ')).toThrow('identity is required');
  });

  it('fails closed on an unexpected authorization result rather than treating it as revoked access', async () => {
    const h = setup(['active']);
    h.rpc.mockResolvedValue({ data: null, error: null });
    await expect(h.access.getAvailableAgentProjects('user')).rejects.toThrow('authorization unavailable');
    expect(h.writes).toEqual([]);
  });

  it('deduplicates candidates and only lists projects admitted by the effective-license RPC', async () => {
    const h = setup(['active']);
    expect(await h.tool.execute({ action: 'list' })).toEqual({ success: true, projects: [{ id: 'active', name: 'active' }] });
    expect(h.rpc).toHaveBeenCalledTimes(3);
    expect(h.rpc).toHaveBeenCalledWith('site_user_has_effective_access', { p_site_id: 'suspended', p_user_id: 'user' });
  });

  it('rejects setting a suspended project without modifying the session', async () => {
    const h = setup(['active']);
    expect(await h.tool.execute({ action: 'set', site_id: 'suspended' })).toMatchObject({ success: false });
    expect(h.writes).toEqual([]);
  });

  it('rechecks permission when setting a project and clears the previous instance', async () => {
    const h = setup(['active']);
    expect(await h.tool.execute({ action: 'set', site_id: 'active' })).toMatchObject({ success: true });
    expect(h.writes).toEqual([{ user_id: 'user', site_id: 'active', instance_id: null, phone_number: '+15555550100' }]);
  });

  it('keeps valid sessions but never reuses another actor or an unavailable project', () => {
    const h = setup(['active']);
    const projects = [{ id: 'active', name: 'Active' }];
    expect(h.access.resolveAgentProjectSession('user', projects, { user_id: 'user', site_id: 'active', instance_id: 'original' }))
      .toMatchObject({ siteId: 'active', instanceId: 'original' });
    for (const session of [{ user_id: 'other', site_id: 'active' }, { user_id: 'user', site_id: 'suspended' }]) {
      expect(h.access.resolveAgentProjectSession('user', projects, session)).toMatchObject({ siteId: null, instanceId: null });
    }
  });
});