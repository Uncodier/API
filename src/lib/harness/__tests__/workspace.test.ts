import { WORKSPACE_ISOLATION_VERSION, WORKSPACE_PROCESS_GUARD, WORKSPACE_ROOT_INIT } from '../workspace-process-guard';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { MAX_COMMAND_OUTPUT, WORKSPACE_BOOTSTRAP_PROGRAM, WORKSPACE_ROOT, WorkspaceError, configureWorkspaceEnvironment,
  openWorkspace, parseWorkspaceFileResult, redactWorkspaceOutput, replaceWorkspaceEnvironment, validateWorkspaceRepository,
  suspendWorkspaceForCleanup, workspaceNetworkPolicy, workspacePath } from '../workspace';

jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));

function command(stdout = '', stderr = '', exitCode: number | null = 0, id = 'cmd_1') {
  const close = jest.fn();
  const kill = jest.fn().mockResolvedValue(undefined);
  return {
    cmdId: id, exitCode, kill, wait: jest.fn().mockResolvedValue({ exitCode: exitCode ?? 0 }),
    logs: jest.fn(() => Object.assign((async function* () {
      if (stdout) yield { stream: 'stdout', data: stdout };
      if (stderr) yield { stream: 'stderr', data: stderr };
    })(), { close })),
  };
}

describe('workspace paths, repository validation and result helpers', () => {
  test.each(['../file', '/etc/passwd', '/vercel/sandbox-other/x', '.env', 'src/.env.local',
    'keys/server.pem', '.ssh/id_ed25519', '.git/config', 'x/../ok', 'file\0name', 'a\\b'])('rejects %s', path => {
    expect(() => workspacePath(path)).toThrow(WorkspaceError);
  });
  test('normalizes contained POSIX paths without accepting traversal', () => {
    expect(workspacePath('./src/app.ts')).toBe('/vercel/sandbox/src/app.ts');
    expect(workspacePath('/vercel/sandbox')).toBe(WORKSPACE_ROOT);
    expect(workspacePath('src/keyboards.ts')).toBe('/vercel/sandbox/src/keyboards.ts');
  });
  test.each(['file:///tmp/repo', 'http://git.example.invalid/repo', 'https://127.0.0.1/repo',
    'https://169.254.169.254/repo', 'https://example.internal/repo', 'https://git.example.invalid/a?token=x',
    'https://git.example.invalid/a#x', 'https://git.example.invalid/a/../b', 'https://git.example.invalid/a%2fb'])('rejects unsafe repository %s', url => {
    expect(() => validateWorkspaceRepository({ url })).toThrow(WorkspaceError);
  });
  test('rejects auth URLs without echoing either credential', () => {
    const username = randomBytes(12).toString('hex');
    const password = randomBytes(24).toString('hex');
    const url = new URL('https://github.com/team/repo.git');
    url.username = username; url.password = password;
    let message = '';
    try { validateWorkspaceRepository({ url: url.href }); } catch (error) { message = String(error); }
    expect(message).not.toContain(username); expect(message).not.toContain(password);
  });
  test('brokers only exact git endpoints and denies private/metadata networks', () => {
    const git = { username: randomBytes(12).toString('hex'), password: randomBytes(24).toString('hex') };
    const policy = workspaceNetworkPolicy(new URL('https://github.com/team/repo.git'), git);
    expect(typeof policy).toBe('object');
    if (typeof policy === 'string') throw new Error('Expected custom policy');
    expect(policy.subnets?.deny).toEqual(expect.arrayContaining(['169.254.0.0/16', '10.0.0.0/8', '192.168.0.0/16']));
    expect(policy.subnets?.deny?.every(cidr => !cidr.includes(':'))).toBe(true);
    expect(policy.subnets?.allow).toBeUndefined();
    const allow = policy.allow as Record<string, Array<{ match: { path: { exact: string } }; transform: unknown }>>;
    expect(allow['*']).toEqual([]);
    expect(allow['github.com']).toHaveLength(3);
    expect(JSON.stringify(allow)).not.toContain('git-receive-pack');
    const writable = workspaceNetworkPolicy(new URL('https://github.com/team/repo.git'), { ...git, allowPush: true });
    if (typeof writable === 'string') throw new Error('Expected custom policy');
    expect((writable.allow as Record<string, unknown[]>)['github.com']).toHaveLength(5);
    for (const rule of allow['github.com'].slice(0, -1)) {
      expect(rule.match.path.exact).toMatch(/^\/team\/repo\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/);
    }
  });
  test('redacts known secrets, auth headers and authenticated URL components', () => {
    const user = randomBytes(12).toString('hex'); const secret = randomBytes(24).toString('hex');
    const url = new URL('https://api.example.invalid/test'); url.username = user; url.password = secret;
    const result = redactWorkspaceOutput(`${url.href} Authorization: Bearer ${secret}\n${user}`, [user, secret]);
    expect(result).not.toContain(user); expect(result).not.toContain(secret);
    expect(result).toContain('[REDACTED]');
  });
  test('file result parser emits static errors', () => {
    expect(parseWorkspaceFileResult('{"ok":true,"content":"hello"}')).toEqual({ ok: true, content: 'hello' });
    expect(() => parseWorkspaceFileResult('{"ok":false,"code":"PATH_DENIED"}')).toThrow(expect.objectContaining({ code: 'PATH_DENIED' }));
    expect(() => parseWorkspaceFileResult('not json')).toThrow('invalid output');
  });
});

describe('Vercel SDK 3.2.1 workspace adapter, offline', () => {
  const sessionId = randomUUID();
  const name = `h-${sessionId}`;
  const repository = { url: 'https://github.com/team/repo.git', ref: 'feature/scaffold' };
  const tags = { harnessIsolation: WORKSPACE_ISOLATION_VERSION, harnessSession: sessionId, harnessRepository: createHash('sha256').update(JSON.stringify([repository.url, repository.ref])).digest('hex'), harnessReady: 'true' };
  let sandbox: { name: string; persistent: boolean; tags: typeof tags; status: string; currentSnapshotId?: string;
    runCommand: jest.Mock; update: jest.Mock; stop: jest.Mock; getCommand: jest.Mock };
  beforeEach(() => {
    jest.clearAllMocks();
    sandbox = { name, persistent: true, tags: { ...tags }, status: 'running', runCommand: jest.fn().mockResolvedValue(command()),
      update: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue({}), getCommand: jest.fn().mockResolvedValue(command()) };
    (Sandbox.get as jest.Mock).mockRejectedValue({ response: { status: 404 } });
    (Sandbox.create as jest.Mock).mockResolvedValue(sandbox);
  });
  const attach = async () => {
    (Sandbox.get as jest.Mock).mockResolvedValue(sandbox);
    return openWorkspace({ sessionId, repository, existing: { provider: 'vercel', id: name, root: WORKSPACE_ROOT } });
  };
  test('clones generically in repo root without token, install, provisioning, hooks or host environment', async () => {
    const workspace = await openWorkspace({ sessionId, repository });
    expect(workspace.ref).toEqual({ provider: 'vercel', id: name, root: WORKSPACE_ROOT });
    expect(Sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ name, persistent: true, env: {}, ports: [], image: 'vercel/sandbox/universal' }));
    expect(Sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ snapshotExpiration: 7 * 24 * 60 * 60 * 1000,
      keepLastSnapshots: { count: 1, deleteEvicted: true } }));
    const calls = sandbox.runCommand.mock.calls.map(([value]) => value).filter(value => !value.args.includes(WORKSPACE_ROOT_INIT));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toMatchObject({ cmd: '/usr/bin/env', cwd: '/', env: {}, sudo: true, detached: true, timeoutMs: 120000 });
    expect(call.args).toEqual(expect.arrayContaining([WORKSPACE_PROCESS_GUARD, '-i']));
    const payload = JSON.parse(call.args.at(-1));
    expect(payload).toMatchObject({ root: WORKSPACE_ROOT, sessionId, url: repository.url, ref: repository.ref });
    expect(call.args).toContain(WORKSPACE_BOOTSTRAP_PROGRAM);
    expect(WORKSPACE_BOOTSTRAP_PROGRAM).toContain("'clone', '--no-recurse-submodules'");
    expect(WORKSPACE_BOOTSTRAP_PROGRAM).toContain('core.hooksPath=/dev/null');
    expect(WORKSPACE_BOOTSTRAP_PROGRAM).toContain('http.followRedirects=false');
    expect(WORKSPACE_BOOTSTRAP_PROGRAM).not.toMatch(/npm|GITHUB_TOKEN|provision|next|rmtree|rm -rf|reset --hard/i);
    expect(WORKSPACE_BOOTSTRAP_PROGRAM).toContain('owner.json');
    await workspace.suspend();
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(2);
  });
  test('explicit existing failure and transient lookup failure never create a fresh VM', async () => {
    await expect(openWorkspace({ sessionId, repository, existing: { provider: 'vercel', id: name, root: WORKSPACE_ROOT } })).rejects.toMatchObject({ code: 'WORKSPACE_OPEN_FAILED' });
    expect(Sandbox.create).not.toHaveBeenCalled();
    (Sandbox.get as jest.Mock).mockRejectedValue({ response: { status: 503 } });
    await expect(openWorkspace({ sessionId, repository })).rejects.toMatchObject({ code: 'WORKSPACE_OPEN_FAILED' });
    expect(Sandbox.create).not.toHaveBeenCalled();
  });
  test('bootstrap failure stops only the created owned handle without deleting work', async () => {
    sandbox.runCommand.mockImplementation(async input => command('', '', input.args.includes(WORKSPACE_BOOTSTRAP_PROGRAM) ? 74 : 0));
    const cleanupCreated = jest.fn(async sbx => { await sbx.stop(); });
    await expect(openWorkspace({ sessionId, repository, cleanupCreated })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_READY' });
    expect(cleanupCreated).toHaveBeenCalledWith(sandbox); expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(Sandbox.create).toHaveBeenCalledTimes(1);
  });
  test('lease loss after create uses cleanup claim but never stale active stop', async () => {
    const cleanupCreated = jest.fn().mockRejectedValue(new Error('lost owner'));
    let lost = false;
    (Sandbox.create as jest.Mock).mockImplementation(async () => { lost = true; return sandbox; });
    await expect(openWorkspace({ sessionId, repository, cleanupCreated, assertActive: async () => { if (lost) throw new Error('lost'); } }))
      .rejects.toMatchObject({ code: 'ABORTED' });
    expect(cleanupCreated).toHaveBeenCalledWith(sandbox); expect(sandbox.stop).not.toHaveBeenCalled();
  });
  test('cleanup suspend ignores aborted slice signal only under durable fence', async () => {
    const controller = new AbortController();
    const workspace = await openWorkspace({ sessionId, repository, signal: controller.signal });
    controller.abort();
    const assertFence = jest.fn().mockResolvedValue(undefined);
    await suspendWorkspaceForCleanup(workspace, assertFence);
    expect(assertFence).toHaveBeenCalledTimes(2); expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.stop.mock.calls[0][0].signal.aborted).toBe(false);
  });
  test('reconnect validates scope, readiness and snapshot; never reruns clone', async () => {
    await attach();
    expect(sandbox.runCommand).not.toHaveBeenCalled();
    sandbox.status = 'stopped';
    await expect(attach()).rejects.toMatchObject({ code: 'WORKSPACE_SNAPSHOT_MISSING' });
    expect(Sandbox.create).not.toHaveBeenCalled();
    sandbox.currentSnapshotId = 'snap_offline';
    await attach();
    await expect(openWorkspace({ sessionId, repository, existing: { provider: 'vercel', id: `h-${randomUUID()}`, root: WORKSPACE_ROOT } })).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_MISMATCH' });
  });
  test('private git credentials appear only in broker policy, never command/create env/source/output', async () => {
    const username = randomBytes(12).toString('hex'); const password = randomBytes(24).toString('hex');
    const workspace = await openWorkspace({ sessionId, repository, host: { git: { username, password } } });
    const serializedCalls = JSON.stringify(sandbox.runCommand.mock.calls);
    expect(serializedCalls).not.toContain(username); expect(serializedCalls).not.toContain(password);
    const created = (Sandbox.create as jest.Mock).mock.calls[0][0];
    expect(created.source).toBeUndefined(); expect(created.env).toEqual({});
    sandbox.runCommand.mockResolvedValue(command(`${username}\n${password}`));
    const output = await workspace.exec({ command: 'echo test' });
    expect(output.stdout).not.toContain(username); expect(output.stdout).not.toContain(password);
  });
  test('runtime environment is host-only opt in, redacted after parsing file JSON, and not default shell state', async () => {
    const workspace = await attach();
    const value = randomBytes(24).toString('hex');
    await configureWorkspaceEnvironment(workspace, { TENANT_APP_TOKEN: value });
    await workspace.exec({ command: 'echo default' });
    expect(JSON.stringify(sandbox.runCommand.mock.calls.at(-1))).not.toContain(value);
    sandbox.runCommand.mockResolvedValue(command(value));
    const output = await workspace.exec({ command: 'echo runtime', useRuntimeEnvironment: true });
    expect(JSON.stringify(sandbox.runCommand.mock.calls.at(-1))).toContain(value);
    expect(output.stdout).not.toContain(value);
    sandbox.runCommand.mockResolvedValue(command(JSON.stringify({ ok: true, content: value })));
    expect(await workspace.readFile('app.txt')).toBe('[REDACTED]');
    await configureWorkspaceEnvironment(workspace, {});
    await workspace.exec({ command: 'still configured', useRuntimeEnvironment: true });
    expect(JSON.stringify(sandbox.runCommand.mock.calls.at(-1))).toContain(value);
    await replaceWorkspaceEnvironment(workspace, {});
    await expect(workspace.exec({ command: 'run', useRuntimeEnvironment: true })).rejects.toMatchObject({ code: 'RUNTIME_ENVIRONMENT_UNAVAILABLE' });
    await expect(configureWorkspaceEnvironment(workspace, { SUPABASE_SERVICE_ROLE_KEY: value })).rejects.toMatchObject({ code: 'UNSUPPORTED_HOST_ENVIRONMENT' });
  });
  test('stream output is bounded and closes before an unlimited SDK output is buffered', async () => {
    const workspace = await attach();
    const cmd = command('x'.repeat(MAX_COMMAND_OUTPUT * 4));
    sandbox.runCommand.mockResolvedValue(cmd);
    const output = await workspace.exec({ command: 'printf lots' });
    expect(output.stdout.length + output.stderr.length).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT);
    expect(output.truncated).toBe(true);
    expect(cmd.logs.mock.results[0].value.close).toHaveBeenCalled();
    await expect(workspace.exec({ command: 'run', timeoutMs: 120001 })).rejects.toMatchObject({ code: 'INVALID_TIMEOUT' });
  });
  test('background processes are SDK scoped across adapter reconnect, not a memory registry', async () => {
    const workspace = await attach();
    sandbox.runCommand.mockResolvedValue(command('', '', null, 'cmd_background'));
    const result = await workspace.exec({ command: 'sleep 20', background: true });
    expect(result.processId).toBe(`${name}:cmd_background`);
    const resumed = await attach();
    await resumed.processStatus(result.processId!);
    expect(sandbox.getCommand).toHaveBeenCalledWith('cmd_background', { signal: undefined });
    await resumed.stopProcess(result.processId!);
    await expect(resumed.processStatus(`h-${randomUUID()}:cmd_background`)).rejects.toMatchObject({ code: 'INVALID_PROCESS_ID' });
    expect(sandbox.getCommand).toHaveBeenCalledTimes(2);
  });
  test('aborted foreground operation dispatches no cleanup effect and sanitizes SDK error', async () => {
    const workspace = await attach();
    const controller = new AbortController();
    const cmd = command();
    cmd.wait.mockImplementation(async () => { controller.abort(); throw new Error(randomBytes(24).toString('hex')); });
    sandbox.runCommand.mockResolvedValue(cmd);
    await expect(workspace.exec({ command: 'sleep 100' }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(cmd.kill).not.toHaveBeenCalled();
  });
  test('incremental capability environments coexist and complete replacement retains historical redaction', async () => {
    const old = randomBytes(24).toString('hex');
    const database = randomBytes(24).toString('hex');
    const auth = randomBytes(24).toString('hex');
    const rotated = randomBytes(24).toString('hex');
    const workspace = await openWorkspace({ sessionId, repository, host: { environment: { OLD_TOKEN: old }, redactionValues: [rotated] } });
    await configureWorkspaceEnvironment(workspace, { TENANT_DATABASE_URL: database });
    await configureWorkspaceEnvironment(workspace, { APP_AUTH_TOKEN: auth });
    await configureWorkspaceEnvironment(workspace, {});
    sandbox.runCommand.mockResolvedValue(command([old, database, auth, rotated].join('\n')));
    const merged = await workspace.exec({ command: 'run', useRuntimeEnvironment: true });
    const args = sandbox.runCommand.mock.calls.at(-1)[0].args;
    expect(args).toEqual(expect.arrayContaining([`OLD_TOKEN=${old}`, `TENANT_DATABASE_URL=${database}`, `APP_AUTH_TOKEN=${auth}`]));
    for (const value of [old, database, auth, rotated]) expect(merged.stdout).not.toContain(value);
    await replaceWorkspaceEnvironment(workspace, { APP_AUTH_TOKEN: rotated }, [database]);
    const replaced = await workspace.exec({ command: 'run', useRuntimeEnvironment: true });
    const replacement = sandbox.runCommand.mock.calls.at(-1)[0].args;
    expect(replacement).toContain(`APP_AUTH_TOKEN=${rotated}`);
    for (const value of [old, database, auth]) expect(JSON.stringify(replacement)).not.toContain(value);
    for (const value of [old, database, auth, rotated]) expect(replaced.stdout).not.toContain(value);
  });
  test.each(['lookup', 'create', 'policy', 'clone', 'tag'])('cancellation after %s blocks every subsequent SDK dispatch', async boundary => {
    const controller = new AbortController();
    const cancel = () => { controller.abort(); };
    if (boundary === 'lookup') (Sandbox.get as jest.Mock).mockImplementation(async () => { cancel(); throw { response: { status: 404 } }; });
    if (boundary === 'create') (Sandbox.create as jest.Mock).mockImplementation(async () => { cancel(); return sandbox; });
    if (boundary === 'policy' || boundary === 'tag') sandbox.update.mockImplementation(async (input: { tags?: unknown }) => {
      if (boundary === 'tag' ? (input.tags as { harnessReady?: string })?.harnessReady === 'true' : !input.tags) cancel();
    });
    if (boundary === 'clone') sandbox.runCommand.mockImplementation(async input => { if (input.args.includes(WORKSPACE_BOOTSTRAP_PROGRAM)) cancel(); return command(); });
    await expect(openWorkspace({ sessionId, repository, signal: controller.signal, assertActive: async () => {} })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(Sandbox.create).toHaveBeenCalledTimes(boundary === 'lookup' ? 0 : 1);
    expect(sandbox.update).toHaveBeenCalledTimes(['lookup', 'create'].includes(boundary) ? 0 : boundary === 'tag' ? 3 : 2);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(['lookup', 'create'].includes(boundary) ? 0 : boundary === 'policy' ? 1 : 2);
  });
  test('owner loss after policy refresh blocks clone even when signal remains live', async () => {
    let owned = true;
    sandbox.update.mockImplementation(async () => { owned = false; });
    await expect(openWorkspace({ sessionId, repository, assertActive: async () => { if (!owned) throw new Error('lost'); } })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.runCommand.mock.calls[0][0].args).toContain(WORKSPACE_ROOT_INIT);
    expect(sandbox.update).toHaveBeenCalledTimes(1);
  });
  test('transient clone exit 128 can retry same owned incomplete VM, without fresh VM/reset', async () => {
    sandbox.tags.harnessReady = 'false';
    sandbox.runCommand.mockResolvedValueOnce(command()).mockResolvedValueOnce(command('', '', 128)).mockResolvedValue(command());
    await expect(openWorkspace({ sessionId, repository })).rejects.toMatchObject({ code: 'REPOSITORY_CLONE_FAILED' });
    (Sandbox.get as jest.Mock).mockResolvedValue(sandbox);
    await openWorkspace({ sessionId, repository });
    expect(Sandbox.create).toHaveBeenCalledTimes(1);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(3);
    expect(sandbox.update.mock.calls.at(-1)[0].tags.harnessReady).toBe('true');
  });
  test('different owner/repository incomplete VM cannot bootstrap or refresh its policy', async () => {
    sandbox.tags.harnessReady = 'false';
    sandbox.tags.harnessRepository = randomBytes(32).toString('hex');
    (Sandbox.get as jest.Mock).mockResolvedValue(sandbox);
    await expect(openWorkspace({ sessionId, repository })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_READY' });
    expect(Sandbox.create).not.toHaveBeenCalled();
    expect(sandbox.update).not.toHaveBeenCalled();
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });
  test('adapter refuses new effects after owner loss, including process kill after a read', async () => {
    let owned = true;
    const workspace = await openWorkspace({ sessionId, repository, assertActive: async () => { if (!owned) throw new Error('lost'); } });
    const cmd = command();
    sandbox.getCommand.mockImplementation(async () => { owned = false; return cmd; });
    await expect(workspace.stopProcess(`${name}:cmd_1`)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(cmd.kill).not.toHaveBeenCalled();
    sandbox.runCommand.mockClear();
    await expect(workspace.exec({ command: 'touch never' })).rejects.toMatchObject({ code: 'ABORTED', effectStarted: false });
    await expect(workspace.writeFile('never', 'no')).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(workspace.suspend()).rejects.toMatchObject({ code: 'ABORTED' });
    expect(sandbox.runCommand).not.toHaveBeenCalled();
    expect(sandbox.stop).not.toHaveBeenCalled();
  });
  test('host historical secrets remain redacted after reconnect and replacement, including encoded output', async () => {
    const old = `${randomBytes(24).toString('hex')}/+`;
    const current = randomBytes(24).toString('hex');
    const workspace = await openWorkspace({ sessionId, repository, host: { environment: { APP_TOKEN: current }, redactionValues: [old] } });
    await replaceWorkspaceEnvironment(workspace, {});
    sandbox.runCommand.mockResolvedValue(command(`${old}\n${encodeURIComponent(old)}\n${current}`));
    const output = await workspace.exec({ command: 'logs' });
    for (const value of [old, encodeURIComponent(old), current]) expect(output.stdout).not.toContain(value);
    const args = JSON.stringify(sandbox.runCommand.mock.calls.at(-1));
    expect(args).not.toContain(old); expect(args).not.toContain(current);
  });
});