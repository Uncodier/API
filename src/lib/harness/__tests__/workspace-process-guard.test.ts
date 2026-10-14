import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { guardedWorkspaceCommand, WORKSPACE_PROCESS_GUARD, WORKSPACE_ROOT_INIT } from '../workspace-process-guard';
import { workspaceNetworkPolicy } from '../workspace';
jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));

it('always wraps commands in an inline isolated launcher with no optional bypass', () => {
  const secret = randomBytes(24).toString('hex');
  const command = guardedWorkspaceCommand(['-i', 'PATH=/usr/bin:/bin'], 'sh', ['-c', 'printf ok']);
  expect(command).toMatchObject({ cmd: '/usr/bin/env', sudo: true });
  expect(command.args).toEqual(['-i', 'PATH=/usr/bin:/bin', '/usr/bin/python3', '-I', '-S', '-c', WORKSPACE_PROCESS_GUARD, 'sh', '-c', 'printf ok']);
  expect(JSON.stringify(command)).not.toContain(secret);
  expect(WORKSPACE_PROCESS_GUARD.indexOf('libc.prctl(22')).toBeLessThan(WORKSPACE_PROCESS_GUARD.indexOf('os.setuid(1001)'));
  expect(WORKSPACE_PROCESS_GUARD.indexOf('os.setuid(1001)')).toBeLessThan(WORKSPACE_PROCESS_GUARD.indexOf('os.execvp'));
});

it('compiles both trusted Python programs without executing any system changes', () => {
  for (const program of [WORKSPACE_PROCESS_GUARD, WORKSPACE_ROOT_INIT]) {
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', 'import sys;compile(sys.stdin.read(),"guard","exec")'],
      { input: program, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
  }
});

it('evaluates the actual BPF instructions for both ABIs without installing a host filter', () => {
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', String.raw`
import ast,sys
tree=ast.parse(sys.stdin.read())
# Execute ONLY literal assignments/list-building branches, never kernel setup.
body=next(n for n in tree.body if isinstance(n,ast.Try)).body
for machine in ('x86_64','aarch64'):
    scope={'machine':machine}
    for n in body:
        if isinstance(n,ast.If) and ast.unparse(n.test).startswith('machine =='):
            exec(compile(ast.Module(body=[n],type_ignores=[]),'abi','exec'),scope)
        if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='instructions' for t in n.targets):
            exec(compile(ast.Module(body=[n],type_ignores=[]),'bpf','exec'),scope)
        if isinstance(n,ast.For) and isinstance(n.target,ast.Name) and n.target.id=='nr':
            exec(compile(ast.Module(body=[n],type_ignores=[]),'bpf','exec'),scope)
        if isinstance(n,ast.AugAssign) and isinstance(n.target,ast.Name) and n.target.id=='instructions':
            exec(compile(ast.Module(body=[n],type_ignores=[]),'bpf','exec'),scope)
    def run(nr,family=0,arch=None):
        data={0:nr,4:scope['arch'] if arch is None else arch,16:family};pc=0;acc=0
        for _ in range(100):
            code,jt,jf,k=scope['instructions'][pc]
            if code==0x20:acc=data[k];pc+=1
            elif code==0x15:pc+=1+(jt if acc==k else jf)
            elif code==0x35:pc+=1+(jt if acc>=k else jf)
            elif code==0x06:return k
            else:raise AssertionError('unexpected BPF opcode')
        raise AssertionError('unterminated filter')
    sock,pair=scope['sockets']
    assert run(sock,2)==0x7fff0000
    assert run(pair,1)==0x7fff0000
    for family in (1,10,16,17):assert run(sock,family)==0x00050061
    assert run(pair,10)==0x00050061
    for nr in scope['blocked']:assert run(nr)==0x00050001
    assert run(435)==0x00050026
    assert run(0x40000000+sock,2)==0x80000000
    assert run(sock,2,0)==0x80000000
    assert run(1)==0x7fff0000
print('verified')
`], { input: WORKSPACE_PROCESS_GUARD, encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout.trim()).toBe('verified');
});

it('refuses unsupported host platforms rather than executing an unguarded payload', () => {
  if (process.platform === 'linux') return; // Linux kernel behavior is checked by the live isolated probe.
  const marker = randomBytes(16).toString('hex');
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', WORKSPACE_PROCESS_GUARD, '/bin/echo', marker], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(126); expect(result.stdout).not.toContain(marker);
  expect(result.stderr).toBe('Workspace process isolation unavailable.\n');
});

it('sends only supported IPv4 CIDRs and keeps metadata/private/multicast denies', () => {
  const policy = workspaceNetworkPolicy(new URL('https://repo.example.invalid/team/repo.git'));
  if (typeof policy === 'string') throw new Error('Expected restrictive custom policy');
  expect(policy.subnets?.deny).toHaveLength(14);
  expect(policy.subnets?.deny).toEqual(expect.arrayContaining(['0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4']));
  expect(policy.subnets?.allow).toBeUndefined();
  expect(policy.subnets?.deny?.some(cidr => cidr.includes(':'))).toBe(false);
});

it('rejects arbitrary credential proxy origins and pins GitHub Host on all broker requests', () => {
  const username = randomBytes(16).toString('hex'), password = randomBytes(24).toString('hex');
  expect(() => workspaceNetworkPolicy(new URL('https://repo.example.invalid/team/repo.git'), { username, password })).toThrow('public GitHub');
  const policy = workspaceNetworkPolicy(new URL('https://github.com/team/repo.git'), { username, password });
  if (typeof policy === 'string') throw new Error('Expected custom policy');
  const rules = (policy.allow as Record<string, Array<{ match?: unknown; transform: Array<{ headers: Record<string, string> }> }>>)['github.com'];
  for (const rule of rules) expect(rule.transform[0].headers.Host).toBe('github.com');
  const final = rules.at(-1)!;
  expect(final.match).toBeUndefined(); expect(final.transform[0].headers.authorization).toBeUndefined();
  for (const secret of [username, password]) expect(JSON.stringify(final)).not.toContain(secret);
});