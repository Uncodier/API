import { randomBytes, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { guardToolScreen, loadToolScreenAccess, ToolScreenAccessUnavailable } from '../screen-access';
import { SCREEN_ACCESS_READ_TIMEOUT_MS } from '../screen-access-read';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));

const scope = { siteId: randomUUID(), userId: randomUUID() };
type Result = { data: any; error: unknown; status?: number };
let records: Record<string, Result>;
let rpcRead: jest.Mock;
let tableRead: jest.Mock;

function protectedTool() {
  const execute = jest.fn(async (_args: unknown) => ({ ok: true }));
  return { execute, guarded: guardToolScreen({ name: 'list_files', execute }, scope) };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  records = {
    sites: { data: { user_id: scope.userId }, error: null, status: 200 },
    site_ownership: { data: null, error: null, status: 200 },
    site_members: { data: { role: 'collaborator', blocked_screens: [] }, error: null, status: 200 },
  };
  rpcRead = jest.fn(async (_signal: AbortSignal): Promise<Result> => ({ data: true, error: null, status: 200 }));
  tableRead = jest.fn(async (table: string, _signal: AbortSignal): Promise<Result> => records[table]);
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => ({ abortSignal: rpcRead }));
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    let signal: AbortSignal;
    const query: any = {};
    query.select = query.eq = () => query;
    query.abortSignal = (value: AbortSignal) => { signal = value; return query; };
    query.maybeSingle = () => tableRead(table, signal);
    return query;
  });
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it('does not make a verified owner depend on unrelated membership reads', async () => {
  records.site_ownership.error = records.site_members.error = { code: '57014' };
  const { execute, guarded } = protectedTool();
  expect(await guarded.execute({})).toEqual({ ok: true });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(tableRead.mock.calls.map(([table]) => table)).toEqual(['sites']);
  expect(rpcRead).toHaveBeenCalledTimes(1);
});

it('does not exempt an owner from a current denial or later revocation', async () => {
  const { execute, guarded } = protectedTool();
  await guarded.execute({});
  rpcRead.mockResolvedValueOnce({ data: false, error: null });
  await expect(guarded.execute({})).rejects.toMatchObject({ status: 403, effectStarted: false });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(rpcRead).toHaveBeenCalledTimes(2);
});

it('admits a slow effective-access read without consuming the following phase deadline', async () => {
  jest.useFakeTimers();
  const controllers: AbortController[] = [];
  jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController(); controllers.push(controller);
    setTimeout(() => controller.abort(new DOMException('Expired', 'TimeoutError')), ms);
    return controller.signal;
  });
  rpcRead.mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 4857));
    return { data: true, error: null, status: 200 };
  });
  tableRead.mockImplementationOnce(async table => {
    await new Promise(resolve => setTimeout(resolve, 6000));
    return records[table];
  });
  const { execute, guarded } = protectedTool();
  const pending = guarded.execute({});
  await jest.advanceTimersByTimeAsync(4857);
  expect(execute).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(6000);
  await expect(pending).resolves.toEqual({ ok: true });
  expect(rpcRead).toHaveBeenCalledTimes(1);
  expect(controllers).toHaveLength(2);
  expect(controllers[0].signal.aborted).toBe(true);
  expect(controllers[1].signal.aborted).toBe(false);
  expect(rpcRead.mock.calls[0][0]).not.toBe(tableRead.mock.calls[0][1]);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(SCREEN_ACCESS_READ_TIMEOUT_MS);
});

it.each([
  { code: '57014', status: 500 }, { code: 'PGRST003', status: 504 },
  { code: '', status: 0 }, { code: '', status: 503 },
])('retries a transient permission read, never the tool: %j', async failure => {
  rpcRead.mockResolvedValueOnce({ data: null, error: { code: failure.code }, status: failure.status });
  const { execute, guarded } = protectedTool();
  expect(await guarded.execute({})).toEqual({ ok: true });
  expect(rpcRead).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('uses fresh authorization after role lookup failure rather than reusing prior permission', async () => {
  records.sites.data.user_id = randomUUID();
  records.site_members = { data: null, error: { code: '57014' }, status: 500 };
  rpcRead.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: false, error: null });
  const { execute, guarded } = protectedTool();
  await expect(guarded.execute({})).rejects.toMatchObject({ status: 403, effectStarted: false });
  expect(rpcRead).toHaveBeenCalledTimes(2);
  expect(tableRead.mock.calls.map(([table]) => table)).toEqual(['sites', 'site_ownership', 'site_members']);
  expect(execute).not.toHaveBeenCalled();
});

it('enforces newly blocked screens when the second role lookup succeeds', async () => {
  records.sites.data.user_id = randomUUID();
  let roleReads = 0;
  tableRead.mockImplementation(async table => {
    if (table !== 'site_members') return records[table];
    if (++roleReads === 1) return { data: null, error: { code: '57014' }, status: 500 };
    return { data: { role: 'collaborator', blocked_screens: ['applicationsRepositories'] }, error: null, status: 200 };
  });
  const { execute, guarded } = protectedTool();
  await expect(guarded.execute({})).rejects.toMatchObject({ status: 403, effectStarted: false });
  expect(rpcRead).toHaveBeenCalledTimes(2);
  expect(roleReads).toBe(2);
  expect(execute).not.toHaveBeenCalled();
});

it('uses a fresh deadline after timeout and does not accept late results from the first attempt', async () => {
  const first = new AbortController();
  const fresh = new AbortController();
  jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(first.signal).mockReturnValue(fresh.signal);
  let resolveOld!: (value: Result) => void;
  rpcRead.mockImplementationOnce(() => new Promise<Result>(resolve => { resolveOld = resolve; first.abort(); }));
  const { execute, guarded } = protectedTool();
  expect(await guarded.execute({})).toEqual({ ok: true });
  expect(rpcRead).toHaveBeenCalledTimes(2);
  expect(rpcRead.mock.calls[1][0]).toBe(fresh.signal);
  resolveOld({ data: false, error: null });
  await Promise.resolve();
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([
  { code: '42501', status: 403 }, { code: '42703', status: 400 },
  { code: 'PGRST202', status: 404 }, { code: 'PGRST116', status: 406 },
  { code: '42501', status: 500 },
])('does not retry configuration, privileges or cardinality errors: %j', async failure => {
  rpcRead.mockResolvedValue({ data: null, error: { code: failure.code }, status: failure.status });
  const { execute, guarded } = protectedTool();
  await expect(guarded.execute({})).rejects.toMatchObject({ status: 503, effectStarted: false });
  expect(rpcRead).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
});

it('caps a persistent outage at two attempts, with no effect and no positive cache', async () => {
  rpcRead.mockResolvedValue({ data: null, error: { code: '57014' }, status: 500 });
  const { execute, guarded } = protectedTool();
  await expect(guarded.execute({})).rejects.toMatchObject({ status: 503, effectStarted: false });
  expect(rpcRead).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
  rpcRead.mockResolvedValueOnce({ data: false, error: null });
  expect(await loadToolScreenAccess(scope)).toBeNull();
  expect(rpcRead).toHaveBeenCalledTimes(3);
});

it('does not retry a tool that throws after access was confirmed', async () => {
  const execute = jest.fn(async (_args: unknown) => { throw new TypeError('socket timeout after effect'); });
  const tool = guardToolScreen({ name: 'list_files', execute }, scope);
  await expect(tool.execute({})).rejects.toThrow('socket timeout after effect');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(rpcRead).toHaveBeenCalledTimes(1);
});

it('logs only bounded diagnostic fields, without credential-bearing backend details or actor IDs', async () => {
  const secrets = Array.from({ length: 3 }, () => randomBytes(24).toString('hex'));
  const url = new URL('https://permissions.example.invalid/lookup');
  url.username = secrets[0]; url.password = secrets[1]; url.searchParams.set('token', secrets[2]);
  rpcRead.mockResolvedValue({ data: null, error: { code: '42501', message: url.href, details: scope }, status: 403 });
  const error = await loadToolScreenAccess(scope).catch(error => error);
  expect(error).toBeInstanceOf(ToolScreenAccessUnavailable);
  expect(console.warn).toHaveBeenCalledWith('[ToolScreenAccess] Permission read unavailable', {
    phase: 'effective_access', reason: 'backend', code: '42501', attempt: 1, retrying: false, elapsed_ms: expect.any(Number),
  });
  for (const value of [...secrets, url.hostname, scope.siteId, scope.userId]) {
    expect(JSON.stringify(jest.mocked(console.warn).mock.calls)).not.toContain(value);
    expect(String(error)).not.toContain(value);
  }
});