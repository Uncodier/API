import { randomBytes, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { routeTools, toolsRouterTool, withToolsRouter } from '../assistantProtocol';
import {
  assertToolScreenAccess, guardFinalToolCatalog, guardToolScreen, loadToolScreenAccess,
  ToolScreenAccessDenied, ToolScreenAccessUnavailable,
} from '../screen-access';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: { generateEmbeddings: jest.fn() } }));

const scope = { siteId: randomUUID(), userId: randomUUID() };
const otherUser = randomUUID();
const credentialValues = Array.from({ length: 3 }, () => randomBytes(24).toString('hex'));
const privateUrl = new URL('https://permissions.example.invalid/lookup');
privateUrl.username = credentialValues[0];
privateUrl.password = credentialValues[1];
privateUrl.searchParams.set('token', credentialValues[2]);
const dbError = { message: `Lookup failed: ${privateUrl.href}`, details: scope.siteId, hint: scope.userId };
const unavailable = {
  success: false, code: 'TOOL_SCREEN_ACCESS_UNAVAILABLE', status: 503, recoverable: true, executed: false,
  error: { code: 'TOOL_SCREEN_ACCESS_UNAVAILABLE', message: 'Tool screen permissions are temporarily unavailable.', effectStarted: false },
};
const denied = {
  success: false, code: 'TOOL_SCREEN_ACCESS_DENIED', status: 403, executed: false,
  error: { code: 'TOOL_SCREEN_ACCESS_DENIED', message: 'Tool access denied by screen permissions.', effectStarted: false },
};
type QueryResult = { data: any; error: unknown };
let effective: QueryResult;
let records: Record<string, QueryResult>;
let queries: Record<string, any>;

function tool(name = 'transactions') {
  return {
    name, description: `Private ${randomUUID()}`,
    parameters: { type: 'object', properties: { [randomUUID()]: { type: 'string' } } },
    execute: jest.fn(async (..._args: any[]) => ({ success: true })),
  };
}

function expectNoPrivateDetails(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [...credentialValues, scope.siteId, scope.userId, privateUrl.host]) {
    expect(text).not.toContain(secret);
  }
}

beforeEach(() => {
  jest.resetAllMocks();
  effective = { data: true, error: null };
  records = {
    sites: { data: { user_id: otherUser }, error: null },
    site_ownership: { data: null, error: null },
    site_members: { data: { role: 'collaborator', blocked_screens: [] }, error: null },
  };
  queries = {};
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => ({ abortSignal: async () => effective }));
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const query: any = {};
    for (const name of ['select', 'eq', 'abortSignal']) query[name] = jest.fn(() => query);
    query.maybeSingle = jest.fn(async () => records[table]);
    queries[table] = query;
    return query;
  });
});

afterEach(() => jest.restoreAllMocks());

it.each(['rpc', 'sites', 'site_ownership', 'site_members'])('classifies %s response errors as unavailable without retaining DB details', async source => {
  if (source === 'rpc') effective.error = dbError;
  else records[source].error = dbError;
  const error = await loadToolScreenAccess(scope).catch(error => error);
  expect(error).toBeInstanceOf(ToolScreenAccessUnavailable);
  expect(error).toMatchObject({ name: 'ToolScreenAccessUnavailable', code: unavailable.code, status: 503, recoverable: true });
  expect(error.message).toBe(unavailable.error.message);
  expect(error).not.toHaveProperty('cause');
  expect(error).not.toHaveProperty('effectStarted');
  expectNoPrivateDetails({ ...error, message: error.message, stack: error.stack });
});

it.each(['rpc throw', 'rpc rejection', 'query throw', 'query rejection'])('sanitizes %s as unavailable', async failure => {
  const error = Object.assign(new Error(dbError.message), dbError);
  if (failure === 'rpc throw') (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => { throw error; });
  if (failure === 'rpc rejection') (supabaseAdmin.rpc as jest.Mock).mockReturnValue({ abortSignal: () => Promise.reject(error) });
  if (failure === 'query throw') (supabaseAdmin.from as jest.Mock).mockImplementation(() => { throw error; });
  if (failure === 'query rejection') {
    (supabaseAdmin.from as jest.Mock).mockReturnValue({
      select() { return this; }, eq() { return this; }, abortSignal() { return this; },
      maybeSingle: () => Promise.reject(error),
    });
  }
  const failureResult = await loadToolScreenAccess(scope).catch(error => error);
  expect(failureResult).toBeInstanceOf(ToolScreenAccessUnavailable);
  expect(failureResult).toMatchObject({ code: unavailable.code, status: 503, recoverable: true });
  expectNoPrivateDetails({ ...failureResult, message: failureResult.message, stack: failureResult.stack });
});

it.each(['list', 'search', 'describe', 'call'] as const)('returns recoverable pre-effect data for router %s during an outage, not a denial or catalog', async action => {
  effective.error = dbError;
  const target = tool();
  const router = toolsRouterTool([target], scope);
  const result = await router.execute({ action, name: target.name, query: target.name, args: dbError });
  expect(result).toEqual(unavailable);
  expectNoPrivateDetails(result);
  expect(JSON.stringify(result)).not.toContain(target.description);
  expect(JSON.stringify(result)).not.toContain(Object.keys(target.parameters.properties)[0]);
  for (const field of ['tools', 'parameters', 'categories', 'hint']) expect(result).not.toHaveProperty(field);
  expect(target.execute).not.toHaveBeenCalled();
  expect(EmbeddingsService.generateEmbeddings).not.toHaveBeenCalled();
});

it.each(['describe', 'call'] as const)('returns denied pre-effect proof for %s without exposing schemas', async action => {
  records.site_members.data.blocked_screens = ['transactions'];
  const target = tool();
  expect(await toolsRouterTool([target], scope).execute({ action, name: target.name, args: dbError })).toEqual(denied);
  expect(target.execute).not.toHaveBeenCalled();
});

it.each([undefined, { siteId: scope.siteId }, { siteId: 'invalid', userId: scope.userId }, { siteId: scope.siteId, userId: 'invalid' }])(
  'keeps missing/invalid trusted scope denied without querying or trusting model scope (%j)', async invalidScope => {
    const target = tool();
    await expect(loadToolScreenAccess(invalidScope)).resolves.toBeNull();
    expect(await toolsRouterTool([target], invalidScope).execute({ action: 'call', name: target.name, args: {
      site_id: scope.siteId, user_id: scope.userId, role: 'admin', blocked_screens: [],
    } })).toEqual(denied);
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
    expect(target.execute).not.toHaveBeenCalled();
  },
);

it.each([false, null, 'true'])('keeps ineffective/malformed access %j denied without reading membership', async data => {
  effective.data = data;
  await expect(loadToolScreenAccess(scope)).resolves.toBeNull();
  await expect(assertToolScreenAccess('transactions', scope)).rejects.toBeInstanceOf(ToolScreenAccessDenied);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it.each(['missing site', 'missing member', 'malformed blocked screens', 'malformed blocked entry'])('keeps %s on the legitimate null path', async reason => {
  if (reason === 'missing site') records.sites.data = null;
  if (reason === 'missing member') records.site_members.data = null;
  if (reason === 'malformed blocked screens') records.site_members.data.blocked_screens = 'transactions';
  if (reason === 'malformed blocked entry') records.site_members.data.blocked_screens = [false];
  await expect(loadToolScreenAccess(scope)).resolves.toBeNull();
  const target = tool();
  expect(await toolsRouterTool([target], scope).execute({ action: 'call', name: target.name })).toEqual(denied);
  expect(target.execute).not.toHaveBeenCalled();
});

it('shares the bounded abort signal and binds every membership lookup to the trusted scope', async () => {
  const signal = new AbortController().signal;
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
  const abortSignal = jest.fn(async () => effective);
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue({ abortSignal });
  await expect(loadToolScreenAccess(scope)).resolves.toEqual({ isAdmin: false, blockedScreens: [] });
  expect(timeout).toHaveBeenCalledWith(5_000);
  expect(supabaseAdmin.rpc).toHaveBeenCalledWith('site_user_has_effective_access', { p_site_id: scope.siteId, p_user_id: scope.userId });
  expect(abortSignal).toHaveBeenCalledWith(signal);
  expect(queries.sites.eq).toHaveBeenCalledWith('id', scope.siteId);
  for (const table of ['site_ownership', 'site_members']) {
    expect(queries[table].eq).toHaveBeenCalledWith('site_id', scope.siteId);
    expect(queries[table].eq).toHaveBeenCalledWith('user_id', scope.userId);
  }
  expect(queries.site_members.eq).toHaveBeenCalledWith('status', 'active');
  for (const query of Object.values(queries)) expect(query.abortSignal).toHaveBeenCalledWith(signal);
});

it.each(['rpc', 'membership'])('does not grant admin access when the signal times out during %s even if DB returns success', async phase => {
  const controller = new AbortController();
  jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  records.site_members.data.role = 'admin';
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue({ abortSignal: async () => {
    if (phase === 'rpc') controller.abort();
    return effective;
  } });
  const original = (supabaseAdmin.from as jest.Mock).getMockImplementation()!;
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    if (phase === 'membership') controller.abort();
    return original(table);
  });
  const target = tool();
  expect(await toolsRouterTool([target], scope).execute({ action: 'call', name: target.name })).toEqual(unavailable);
  expect(target.execute).not.toHaveBeenCalled();
  if (phase === 'rpc') expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('does not dispatch after a timed-out lookup eventually resolves successfully', async () => {
  const controller = new AbortController();
  jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  let resolve!: (value: QueryResult) => void;
  const lookup = new Promise<QueryResult>(done => { resolve = done; });
  let start!: () => void;
  const started = new Promise<void>(done => { start = done; });
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue({ abortSignal: () => { start(); return lookup; } });
  const target = tool();
  const result = toolsRouterTool([target], scope).execute({ action: 'call', name: target.name });
  await started;
  controller.abort();
  resolve({ data: true, error: null });
  expect(await result).toEqual(unavailable);
  expect(target.execute).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it.each(['unknown_tool', 'sandbox_unknown', 'qa_unknown', '__proto__', 'constructor'])(
  'denies unknown %s before a DB outage, including direct guards', async name => {
    effective.error = dbError;
    const target = tool(name);
    const router = toolsRouterTool([target], scope);
    for (const action of ['describe', 'call'] as const) expect(await router.execute({ action, name })).toEqual(denied);
    await expect(guardToolScreen(target, scope).execute({})).rejects.toMatchObject({
      code: denied.code, status: 403, executed: false, effectStarted: false,
    });
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
    expect(target.execute).not.toHaveBeenCalled();
  },
);

it('keeps screen-independent targets available without any permission DB initialization', async () => {
  effective.error = dbError;
  const target = tool('webSearch');
  await expect(guardToolScreen(target, scope).execute({})).resolves.toEqual({ success: true });
  const router = toolsRouterTool([target], scope);
  expect(await router.execute({ action: 'describe', name: target.name })).toMatchObject({ success: true });
  expect(await router.execute({ action: 'call', name: target.name })).toMatchObject({ success: true });
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(target.execute).toHaveBeenCalledTimes(2);
});

it.each(['guard', 'routeTools', 'withToolsRouter', 'finalCatalog'] as const)(
  '%s attaches no-effect proof only to screen/scope failures before underlying dispatch', async wrapper => {
    const target = tool('requirements');
    const guarded = wrapper === 'guard' ? guardToolScreen(target, scope)
      : wrapper === 'routeTools' ? routeTools([target], scope)[0]
      : wrapper === 'withToolsRouter' ? withToolsRouter([target], new Set([target.name]), scope)[0]
      : guardFinalToolCatalog([target], scope)[0];
    effective.error = dbError;
    await expect(guarded.execute({})).rejects.toMatchObject({
      code: unavailable.code, status: 503, recoverable: true, executed: false, effectStarted: false,
    });
    effective.error = null;
    records.site_members.data.blocked_screens = ['requirements'];
    await expect(guarded.execute({})).rejects.toMatchObject({ code: denied.code, status: 403, executed: false, effectStarted: false });
    records.site_members.data.blocked_screens = [];
    for (const args of [{ site_id: randomUUID() }, { siteId: randomUUID() },
      { action: 'create', user_id: otherUser }, { action: 'create', userId: otherUser }]) {
      await expect(guarded.execute(args)).rejects.toMatchObject({ code: denied.code, status: 403, executed: false, effectStarted: false });
    }
    expect(target.execute).not.toHaveBeenCalled();
  },
);

it.each(['site_id', 'siteId', 'user_id', 'userId'])('rejects model authority override %s in router calls with no-effect proof', async field => {
  const target = tool('requirements');
  expect(await toolsRouterTool([target], scope).execute({ action: 'call', name: target.name,
    args: JSON.stringify({ action: 'create', [field]: randomUUID() }),
  })).toEqual(denied);
  expect(target.execute).not.toHaveBeenCalled();
});

it('rechecks after success and outages; no positive permission cache masks revocation or failures', async () => {
  const target = tool();
  const router = toolsRouterTool([target], scope);
  const call = () => router.execute({ action: 'call', name: target.name });
  expect(await call()).toMatchObject({ success: true });
  effective.error = dbError;
  expect(await call()).toEqual(unavailable);
  effective.error = null;
  effective.data = false;
  expect(await call()).toEqual(denied);
  effective.data = true;
  expect(await call()).toMatchObject({ success: true });
  records.site_members.data.blocked_screens = ['transactions'];
  expect(await call()).toEqual(denied);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(5);
  expect(target.execute).toHaveBeenCalledTimes(2);
});

it('keeps an outage confined to its host-owned scope, not another router catalog', async () => {
  const otherScope = { siteId: randomUUID(), userId: randomUUID() };
  const target = tool();
  const first = toolsRouterTool([target], scope);
  const second = toolsRouterTool([target], otherScope);
  (supabaseAdmin.rpc as jest.Mock).mockImplementation((_name, params) => ({ abortSignal: async () =>
    params.p_site_id === scope.siteId ? { data: null, error: dbError } : { data: true, error: null },
  }));
  expect(await first.execute({ action: 'list' })).toEqual(unavailable);
  expect(await second.execute({ action: 'list' })).toMatchObject({ success: true, count: 1 });
  expect(await second.execute({ action: 'call', name: target.name })).toMatchObject({ success: true });
  expect(target.execute).toHaveBeenCalledTimes(1);
  expect(supabaseAdmin.rpc).toHaveBeenLastCalledWith('site_user_has_effective_access', {
    p_site_id: otherScope.siteId, p_user_id: otherScope.userId,
  });
});

it.each(['denied', 'unavailable'] as const)('preserves proof from an inner guarded %s recheck without executing the target', async failure => {
  const target = tool();
  let count = 0;
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => ({ abortSignal: async () => {
    count++;
    return count === 1 ? effective : { data: false, error: failure === 'unavailable' ? dbError : null };
  } }));
  const router = toolsRouterTool([guardToolScreen(target, scope)], scope);
  expect(await router.execute({ action: 'call', name: target.name })).toEqual(failure === 'denied' ? denied : unavailable);
  expect(target.execute).not.toHaveBeenCalled();
});

it.each([ToolScreenAccessDenied, ToolScreenAccessUnavailable])('does not infer proof from a %p thrown after dispatch', async ErrorType => {
  const target = tool();
  const error = new ErrorType();
  target.execute.mockImplementation(async () => { throw error; });
  const guarded = guardToolScreen(target, scope);
  await expect(guarded.execute({})).rejects.toBe(error);
  expect(error).not.toHaveProperty('executed');
  expect(error).not.toHaveProperty('effectStarted');
  const router = toolsRouterTool([guarded], scope);
  const result = await router.execute({ action: 'call', name: target.name });
  expect(result).toMatchObject({ success: false, code: error.code, status: error.status });
  expect(result).not.toHaveProperty('executed');
  expect(result.error).not.toHaveProperty('effectStarted');
  expect(target.execute).toHaveBeenCalledTimes(2);
});

it.each(['TOOL_SCREEN_ACCESS_DENIED', 'TOOL_SCREEN_ACCESS_UNAVAILABLE'])('does not trust code-only %s errors after dispatch or expose their details', async code => {
  const target = tool();
  target.execute.mockImplementation(async () => { throw Object.assign(new Error(dbError.message), { code }); });
  const result = await toolsRouterTool([target], scope).execute({ action: 'call', name: target.name });
  expect(result).toMatchObject({ success: false, code });
  expect(result).not.toHaveProperty('executed');
  expect(result.error).not.toHaveProperty('effectStarted');
  expectNoPrivateDetails(result);
  expect(target.execute).toHaveBeenCalledTimes(1);
});