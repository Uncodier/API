import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isIP } from 'node:net';
import { Sandbox, type Command, type NetworkPolicy, type NetworkPolicyRule } from '@vercel/sandbox';
import type { CommandInput, CommandOutput, Workspace, WorkspaceRef } from './types';
import { createRedactor, runtimeSecretValues } from './security';

export const WORKSPACE_ROOT = '/vercel/sandbox';
export const MAX_COMMAND_OUTPUT = 64 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_COMMAND_MS = 120_000;

/** Messages are deliberately static: SDK errors can contain request credentials. */
export class WorkspaceError extends Error {
  constructor(public readonly code: string, message: string, public effectStarted?: boolean) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const fail = (code: string, message: string): never => { throw new WorkspaceError(code, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secretPart = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.config|\.kube|\.gnupg|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|\.(?:pem|key|p12|pfx|keystore)$/i;

/** Lexical validation is repeated inside the VM with descriptor-relative no-follow IO. */
export function workspacePath(path: string, root = WORKSPACE_ROOT): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f\\]/.test(path)) {
    return fail('INVALID_PATH', 'A nonempty POSIX workspace path is required.');
  }
  const parts = path.split('/');
  if (parts.includes('..')) return fail('PATH_DENIED', 'Parent traversal is not allowed.');
  const absolute = posix.resolve(root, path);
  if (absolute !== root && !absolute.startsWith(root + '/')) return fail('PATH_DENIED', 'Path is outside the workspace.');
  if (posix.relative(root, absolute).split('/').some(part => secretPart.test(part))) {
    return fail('PATH_DENIED', 'Secret files and private configuration paths are not accessible through file tools.');
  }
  return absolute;
}

export function validateWorkspaceRepository(repository: { url: string; ref?: string }): URL {
  let url: URL;
  try { url = new URL(repository.url); } catch { return fail('INVALID_REPOSITORY', 'Repository must be a public HTTPS URL.'); }
  const host = url.hostname.toLowerCase();
  if (repository.url.length > 2048 || /[\s\\]/.test(repository.url) || url.protocol !== 'https:' ||
      url.username || url.password || url.search || url.hash || url.port || isIP(host.replace(/^\[|\]$/g, '')) ||
      !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host) ||
      !/^\/[A-Za-z0-9._~/-]+$/.test(url.pathname) || url.pathname.includes('//') ||
      url.pathname.split('/').some(p => p === '..' || p === '.')) {
    return fail('INVALID_REPOSITORY', 'Repository must use HTTPS without credentials, query, fragment, IP literals or private hostnames.');
  }
  // Reject normalization tricks before URL has removed dot segments.
  if (/%|(?:^|\/)\.{1,2}(?:\/|$)/.test(repository.url.replace(/^https:\/\//, ''))) {
    return fail('INVALID_REPOSITORY', 'Encoded or ambiguous repository paths are not supported.');
  }
  if (repository.ref !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(repository.ref) ||
      repository.ref.includes('..') || repository.ref.includes('//') || repository.ref.endsWith('.lock'))) {
    return fail('INVALID_REPOSITORY_REF', 'Repository ref must be a branch, tag or commit identifier.');
  }
  return url;
}

// The SDK documents deny CIDRs as taking precedence over allowed domains. No
// allow-all mode or subnet bypass is used, including for credentialed requests.
const deniedSubnets = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  '::/128', '::1/128', '::ffff:0:0/96', '64:ff9b::/96', '64:ff9b:1::/48',
  '100::/64', '2001::/32', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8',
];

export interface WorkspaceHostOptions {
  /** Host-authorized, short-lived application-scoped values. NEVER platform credentials.
   * Only exec(useRuntimeEnvironment:true) receives these; never inherited process.env. */
  environment?: Record<string, string>;
  /** Historical host-restored values: redact only, never inject into the VM. */
  redactionValues?: string[];
  /** Host-owned credentials; broker injects them at this repository's exact smart-HTTP endpoints. */
  git?: { username: string; password: string; allowPush?: boolean };
}

export function workspaceNetworkPolicy(url: URL, git?: WorkspaceHostOptions['git']): NetworkPolicy {
  const allow: Record<string, NetworkPolicyRule[]> = { '*': [] };
  if (git) {
    if (!git.username || !git.password || git.username.includes(':') ||
        /[\r\n\x00]/.test(git.username + git.password) || git.username.length + git.password.length > 8192) {
      return fail('INVALID_GIT_AUTH', 'Host git credentials are invalid.');
    }
    const path = url.pathname.replace(/\/$/, '');
    const transform = [{ headers: { authorization: `Basic ${Buffer.from(`${git.username}:${git.password}`).toString('base64')}` } }];
    // No domain-wide token, wildcard transform, git credential helper or URL userinfo.
    // Redirects are disabled during clone. Other repos on this host receive no auth.
    allow[url.hostname] = (git.allowPush === true ? ['git-upload-pack', 'git-receive-pack'] : ['git-upload-pack']).flatMap(service => [
      { match: { path: { exact: `${path}/info/refs` }, method: ['GET'],
        queryString: [{ key: { exact: 'service' }, value: { exact: service } }] }, transform },
      { match: { path: { exact: `${path}/${service}` }, method: ['POST'] }, transform },
    ]);
  }
  return { allow, subnets: { deny: [...deniedSubnets] } };
}

function runtimeEnvironment(values: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  if (Object.keys(values).length > 64) return fail('UNSUPPORTED_HOST_ENVIRONMENT', 'Too many runtime environment values.');
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(name) ||
        /^(?:PATH|HOME|SHELL|ENV|BASH_ENV|BASH_FUNC_.*|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|PYTHON.*|GIT_.*|VERCEL_.*|AWS_.*|GOOGLE_.*|OPENROUTER_.*|SUPABASE_SERVICE_ROLE_KEY)$/.test(name) ||
        /(?:SERVICE_ROLE|PRIVATE_KEY)/.test(name) ||
        typeof value !== 'string' || value.length > 8192 || /[\x00\r\n]/.test(value) ||
        /-----BEGIN .*PRIVATE KEY-----/i.test(value)) {
      return fail('UNSUPPORTED_HOST_ENVIRONMENT', 'Runtime environment contains an unsafe variable. Platform credentials must remain on the host.');
    }
    result[name] = value;
  }
  return result;
}

export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

/** Defense in depth; host credentials never reach VM env/argv/files in the first place. */
export function redactWorkspaceOutput(text: string, sensitive: readonly string[] = []): string {
  return createRedactor([...sensitive])(text)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s"']+/gi, '$1[REDACTED]');
}

/**
 * Trusted, dependency-free VM program. It never runs on the API host. No repo
 * imports/startup scripts: python -I -S. All components (including root) use
 * openat + O_NOFOLLOW; hardlinks/devices/FIFOs are rejected. Directory FDs avoid
 * check-then-follow symlink races. File tools intentionally reject ALL symlinks.
 * Shell is not a file ACL: arbitrary code can read VM data; host secrets therefore
 * must remain outside the VM. The VM, not a shell parser, is the execution boundary.
 */
export const WORKSPACE_FILE_PROGRAM = String.raw`
import os, sys, json, stat, re
p = json.loads(''.join(sys.argv[1:]))
root = p['root']
secret = re.compile(r'^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.config|\.kube|\.gnupg|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|\.(?:pem|key|p12|pfx|keystore)$', re.I)
D = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
def denied(): raise ValueError('PATH_DENIED')
def parts(path):
    if not isinstance(path, str) or not path or len(path)>4096 or re.search(r'[\x00-\x1f\x7f\\]', path): denied()
    if '..' in path.split('/'): denied()
    if path.startswith('/'):
        if path != root and not path.startswith(root+'/'): denied()
        path = path[len(root):]
    a = [x for x in path.split('/') if x and x != '.']
    if any(secret.search(x) for x in a): denied()
    return a
def directory(fd, names, create=False):
    fd = os.dup(fd)
    try:
        for name in names:
            if create:
                try: os.mkdir(name, 0o755, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(name, D, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except:
        os.close(fd); raise
def filefd(parent, name, write=False):
    flags = os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_WRONLY | os.O_CREAT if write else os.O_RDONLY)
    fd = os.open(name, flags, 0o600, dir_fd=parent)
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        os.close(fd); denied()
    return fd
def read(parent, name):
    fd = filefd(parent, name)
    try:
        if os.fstat(fd).st_size > 262144: raise ValueError('FILE_TOO_LARGE')
        with os.fdopen(fd, 'rb', closefd=False) as f: data = f.read(262145)
        if len(data)>262144: raise ValueError('FILE_TOO_LARGE')
        if b'\x00' in data: raise ValueError('BINARY_FILE')
        return data.decode('utf-8')
    finally: os.close(fd)
try:
    base = os.open('/', D)
    try: base2 = directory(base, [x for x in root.split('/') if x])
    finally: os.close(base)
    base = base2
    a = parts(p.get('path', '.')); op = p['op']
    if op == 'exec':
        fd = directory(base, a)
        os.fchdir(fd); os.close(fd); os.close(base)
        os.execv('/bin/bash', ['bash', '--noprofile', '--norc', '-c', p['command']])
    elif op in ('read', 'write', 'patch'):
        if not a: denied()
        parent = directory(base, a[:-1], op == 'write' or (op == 'patch' and p.get('create', False)))
        try:
            if op == 'read': result = {'content': read(parent, a[-1])}
            elif op == 'patch':
                create = p.get('create', False)
                flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
                if create: flags |= os.O_CREAT | os.O_EXCL
                fd = os.open(a[-1], flags, 0o600, dir_fd=parent)
                try:
                    s = os.fstat(fd)
                    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1: denied()
                    if s.st_size > 262144: raise ValueError('FILE_TOO_LARGE')
                    with os.fdopen(fd, 'rb', closefd=False) as f: before = f.read(262145).decode('utf-8')
                    if create: after = p['content']
                    else:
                        old = p['oldText']
                        if not old or before.count(old) != 1: raise ValueError('PATCH_CONFLICT')
                        after = before.replace(old, p['newText'], 1)
                    data = after.encode('utf-8')
                    if len(data)>262144: raise ValueError('FILE_TOO_LARGE')
                    os.lseek(fd, 0, os.SEEK_SET)
                    with os.fdopen(fd, 'wb', closefd=False) as f: f.write(data); f.flush()
                    os.ftruncate(fd, len(data))
                    result = {'written': True}
                finally: os.close(fd)
            else:
                data = p['content'].encode('utf-8')
                if len(data)>262144: raise ValueError('FILE_TOO_LARGE')
                fd = filefd(parent, a[-1], True)
                try:
                    os.ftruncate(fd, 0)
                    with os.fdopen(fd, 'wb', closefd=False) as f: f.write(data); f.flush()
                finally: os.close(fd)
                result = {'written': True}
        finally: os.close(parent)
    elif op in ('list', 'search'):
        fd = directory(base, a); items = []; visited = [0]; truncated = [False]
        limit = min(max(int(p.get('limit', 50)), 1), 50)
        query = p.get('query', ''); case = p.get('caseSensitive', True)
        needle = query if case else query.lower()
        def walk(current, prefix, depth):
            if depth > 30 or visited[0] >= 5000: truncated[0] = True; return
            # scandir iterator avoids an unbounded allocation for huge directories.
            with os.scandir(current) as entries:
                for e in entries:
                    visited[0] += 1
                    if visited[0]>5000 or len(items)>=limit: truncated[0] = True; return
                    if secret.search(e.name) or e.name in ('node_modules', '.venv', '__pycache__'): continue
                    if e.is_symlink(): continue
                    name = '/'.join(prefix+[e.name])
                    if e.is_dir(follow_symlinks=False):
                        if op == 'list': items.append({'path': name, 'type': 'directory'})
                        if p.get('recursive', True) or op == 'search':
                            try:
                                child = os.open(e.name, D, dir_fd=current)
                                try: walk(child, prefix+[e.name], depth+1)
                                finally: os.close(child)
                            except OSError: continue
                    elif e.is_file(follow_symlinks=False):
                        if op == 'list': items.append({'path': name, 'type': 'file'})
                        else:
                            try: text = read(current, e.name)
                            except (OSError, ValueError, UnicodeError): continue
                            for number, line in enumerate(text.splitlines(), 1):
                                if needle in (line if case else line.lower()):
                                    items.append({'path': name, 'line': number, 'text': line[:100]})
                                    if len(items)>=limit: truncated[0] = True; return
        try: walk(fd, a, 0)
        finally: os.close(fd)
        result = {'items': items, 'truncated': truncated[0]}
    else: raise ValueError('INVALID_OPERATION')
    os.close(base)
    print(json.dumps({'ok': True, **result}, ensure_ascii=True))
except FileNotFoundError: print(json.dumps({'ok': False, 'code': 'FILE_NOT_FOUND'}))
except FileExistsError: print(json.dumps({'ok': False, 'code': 'PATCH_CONFLICT'}))
except UnicodeError: print(json.dumps({'ok': False, 'code': 'BINARY_FILE'}))
except ValueError as e: print(json.dumps({'ok': False, 'code': str(e) if str(e) in ('PATH_DENIED','FILE_TOO_LARGE','BINARY_FILE','PATCH_CONFLICT') else 'FILE_OPERATION_FAILED'}))
except OSError: print(json.dumps({'ok': False, 'code': 'PATH_DENIED'}))
`;

export function workspaceFileCommand(input: Record<string, unknown>): string {
  return `python3 -I -S -c ${shellQuote(WORKSPACE_FILE_PROGRAM)} ${shellQuote(JSON.stringify({ ...input, root: WORKSPACE_ROOT }))}`;
}

export function parseWorkspaceFileResult(stdout: string): Record<string, unknown> {
  let result: Record<string, unknown>;
  try { result = JSON.parse(stdout); } catch { return fail('FILE_OPERATION_FAILED', 'Workspace file operation returned invalid output.'); }
  if (!result || result.ok !== true) {
    const code = result && ['FILE_NOT_FOUND', 'PATH_DENIED', 'FILE_TOO_LARGE', 'BINARY_FILE', 'PATCH_CONFLICT'].includes(String(result.code))
      ? String(result.code) : 'FILE_OPERATION_FAILED';
    return fail(code, 'Workspace file operation could not be completed safely.');
  }
  return result;
}

const adapters = new WeakMap<Workspace, VercelWorkspace>();

/** Internal adapter file operations preserve JSON before redacting string values. */
export async function workspaceFileOperation(workspace: Workspace, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const adapter = adapters.get(workspace);
  if (adapter) return adapter.file(input, signal);
  const output = await workspace.exec({ command: workspaceFileCommand(input), timeoutMs: 30_000 }, signal);
  if (output.exitCode !== 0 || output.truncated) return fail('FILE_OPERATION_FAILED', 'Workspace file helper failed or exceeded its output limit.');
  return parseWorkspaceFileResult(output.stdout);
}

/**
 * Host-only opt-in for application-scoped runtime values, not a model tool.
 * The host MUST authorize these values and exclude platform/service-role keys;
 * variable names alone cannot establish privilege. No dotenv file is written.
 * Arbitrary VM code can inspect a running application: this is NOT a secret vault.
 * Configure again after reconnect. Default exec never receives these values.
 */
export async function configureWorkspaceEnvironment(workspace: Workspace, values: Record<string, string>): Promise<void> {
  const adapter = adapters.get(workspace);
  if (!adapter) return fail('UNSUPPORTED_WORKSPACE', 'Workspace does not support runtime configuration.');
  await adapter.configure(values);
}

/** Host rebuild/rotation of complete environment layers; historical redaction is monotonic. */
export async function replaceWorkspaceEnvironment(workspace: Workspace, values: Record<string, string>, redactionValues: string[] = []): Promise<void> {
  const adapter = adapters.get(workspace);
  if (!adapter) return fail('UNSUPPORTED_WORKSPACE', 'Workspace does not support runtime configuration.');
  await adapter.configure(values, true, redactionValues);
}

type AssertActive = () => Promise<void>;
const noopActive: AssertActive = async () => {};
async function checkActive(assertActive: AssertActive, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new WorkspaceError('ABORTED', 'Workspace operation was cancelled.', false);
  try { await assertActive(); }
  catch { throw new WorkspaceError('ABORTED', 'Workspace operation no longer owns the active session.', false); }
  if (signal?.aborted) throw new WorkspaceError('ABORTED', 'Workspace operation was cancelled.', false);
}

/** Host-owned bootstrap, never a repository script. No deletion/reset/forced checkout.
 * Clone and checkout happen outside the worktree. Rename installs only into an empty
 * root, atomically; unsupported cross-device installs fail closed and retain staging.
 * An interrupted populated staging directory is quarantined, not removed. */
export const WORKSPACE_BOOTSTRAP_PROGRAM = String.raw`
import json, os, subprocess, sys, uuid
p = json.loads(sys.argv[1])
root = p['root']
stage = os.path.join(p.get('stagingParent', '/tmp'), 'harness-bootstrap-' + p['sessionId'])
marker = {'sessionId': p['sessionId'], 'repository': p['repository'], 'root': root}
def deny(code=73):
    sys.exit(code)
def directory(path):
    return os.path.isdir(path) and not os.path.islink(path) and os.path.realpath(path) == path
git = ['git', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
       '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
       '-c', 'http.followRedirects=false']
def read_git(path, args):
    result = subprocess.run(git + args, cwd=path, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode: return None
    return result.stdout.decode('utf-8', errors='strict').strip()
def target(path):
    ref = p.get('ref')
    if not ref: return read_git(path, ['rev-parse', '--verify', 'refs/remotes/origin/HEAD^{commit}'])
    for revision in [ref + '^{commit}', 'refs/remotes/origin/' + ref + '^{commit}']:
        value = read_git(path, ['rev-parse', '--verify', revision])
        if value: return value
    return None
def valid(path):
    if not directory(path) or not directory(os.path.join(path, '.git')): return False
    if read_git(path, ['config', '--local', '--get-all', 'remote.origin.url']) != p['url']: return False
    head = read_git(path, ['rev-parse', '--verify', 'HEAD^{commit}'])
    return bool(head and head == target(path) and read_git(path, ['cat-file', '-t', head + '^{tree}']) == 'tree')
if not directory(root) or stage == root or stage.startswith(root + os.sep): deny()
if os.listdir(root):
    # Prior bootstrap may have completed the checkout but lost the ready-tag response.
    # Validate identity and target; NEVER change a populated user worktree (even dirty).
    if valid(root): sys.exit(0)
    deny(74)
try:
    os.mkdir(stage, 0o700)
    fd = os.open(os.path.join(stage, 'owner.json'), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as file: json.dump(marker, file)
except FileExistsError:
    if not directory(stage) or os.stat(stage).st_uid != os.getuid(): deny(75)
    try:
        fd = os.open(os.path.join(stage, 'owner.json'), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as file:
            if json.load(file) != marker: deny(75)
    except (OSError, ValueError): deny(75)
checkout = os.path.join(stage, 'checkout')
receipt = os.path.join(stage, 'checkout-complete.json')
def record_receipt(value):
    receipt_new = os.path.join(stage, 'complete-' + str(uuid.uuid4()))
    fd = os.open(receipt_new, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as file: json.dump(value, file)
    os.replace(receipt_new, receipt)
if os.path.lexists(checkout):
    # Even a valid commit can have a partially populated checkout. Never repair it in place.
    # A host completion receipt avoids invoking worktree filters/diff drivers to check it.
    clean = False
    try:
        fd = os.open(receipt, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as file: clean = json.load(file) == marker and valid(checkout)
    except (OSError, ValueError): pass
    if not clean:
        os.rename(checkout, os.path.join(stage, 'quarantine-' + str(uuid.uuid4())))
if not os.path.lexists(checkout):
    # Empty root is rechecked before retrying any network clone.
    if not directory(root) or os.listdir(root): deny()
    record_receipt({'incomplete': True})
    result = subprocess.run(git + ['clone', '--no-recurse-submodules', '--no-checkout', '--template=', '--', p['url'], checkout], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode: sys.exit(128)
    revision = target(checkout)
    if not revision: deny(74)
    result = subprocess.run(git + ['checkout', '--detach', revision], cwd=checkout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode: sys.exit(128)
    # Replace only our own receipt; checkout/user content is never deleted.
    record_receipt(marker)
if not valid(checkout): deny(74)
if not directory(root) or os.listdir(root): deny()
try:
    # POSIX rename cannot replace a nonempty destination. No destructive fallback.
    os.rename(checkout, root)
except OSError: deny(73)
`;

class VercelWorkspace implements Workspace {
  readonly ref: WorkspaceRef;
  private environment: Record<string, string>;
  constructor(private sandbox: Sandbox, private sensitive: string[], environment: Record<string, string>,
    private assertActive: AssertActive, private openingSignal?: AbortSignal) {
    this.ref = { provider: 'vercel', id: sandbox.name, root: WORKSPACE_ROOT };
    this.environment = environment;
  }
  async configure(values: Record<string, string>, replace = false, redactionValues: string[] = []) {
    await this.active();
    this.environment = runtimeEnvironment(replace ? values : { ...this.environment, ...values });
    // Keep old values redacted too: existing process logs may contain them.
    this.sensitive = [...new Set([...this.sensitive, ...runtimeSecretValues(this.environment), ...redactionValues])];
  }

  private active(signal?: AbortSignal): Promise<void> {
    return checkActive(this.assertActive, this.signal(signal));
  }
  private signal(signal?: AbortSignal): AbortSignal | undefined {
    return signal && this.openingSignal ? AbortSignal.any([signal, this.openingSignal]) : signal ?? this.openingSignal;
  }

  private envArgs(useRuntimeEnvironment: boolean): string[] {
    return ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'LANG=C.UTF-8',
      'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null', 'GIT_TERMINAL_PROMPT=0',
      ...Object.entries(useRuntimeEnvironment ? this.environment : {}).map(([key, value]) => `${key}=${value}`)];
  }

  async bootstrap(input: { sessionId: string; repository: string; url: string; ref?: string }, signal?: AbortSignal): Promise<CommandOutput> {
    return this.run('python3', ['-I', '-S', '-c', WORKSPACE_BOOTSTRAP_PROGRAM,
      JSON.stringify({ ...input, root: WORKSPACE_ROOT })], MAX_COMMAND_MS, signal);
  }

  private async collect(command: Command, limit: number, signal?: AbortSignal, observe = false, redact = true): Promise<CommandOutput> {
    await this.active(signal);
    let stdout = '', stderr = '', truncated = false;
    const padding = Math.max(1024, ...this.sensitive.map(s => Math.max(s.length, encodeURIComponent(s).length, JSON.stringify(s).length)));
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = observe ? setTimeout(() => controller.abort(), 150) : undefined;
    const logs = command.logs({ signal: combined });
    try {
      for await (const entry of logs) {
        await this.active(signal);
        const remaining = limit + padding - stdout.length - stderr.length;
        const chunk = entry.data.slice(0, Math.max(0, remaining));
        if (entry.stream === 'stdout') stdout += chunk; else stderr += chunk;
        if (entry.data.length > remaining || stdout.length + stderr.length >= limit + padding) {
          truncated = true;
          break;
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (signal?.aborted) throw new WorkspaceError('ABORTED', 'Workspace operation was cancelled.');
      if (!controller.signal.aborted) throw new WorkspaceError('COMMAND_OUTPUT_UNAVAILABLE', 'Command output is unavailable.');
    } finally { if (timer) clearTimeout(timer); logs.close(); }
    await this.active(signal);
    if (redact) {
      stdout = redactWorkspaceOutput(stdout, this.sensitive);
      stderr = redactWorkspaceOutput(stderr, this.sensitive);
    }
    truncated ||= stdout.length + stderr.length > limit;
    const out = stdout.slice(0, limit);
    return { stdout: out, stderr: stderr.slice(0, Math.max(0, limit - out.length)), exitCode: command.exitCode, truncated };
  }

  private async run(program: string, args: string[], timeoutMs: number, signal?: AbortSignal, background = false, limit = MAX_COMMAND_OUTPUT, useRuntimeEnvironment = false, redact = true): Promise<CommandOutput> {
    signal = this.signal(signal);
    let command: Command | undefined;
    let dispatched = false;
    try {
      await this.active(signal);
      // Always detached: SDK non-detached runCommand accumulates unbounded logs internally.
      dispatched = true;
      command = await this.sandbox.runCommand({ cmd: '/usr/bin/env', args: [...this.envArgs(useRuntimeEnvironment), program, ...args],
        cwd: '/', env: {}, sudo: false, detached: true, timeoutMs, signal });
      await this.active(signal);
      const processId = `${this.ref.id}:${command.cmdId}`;
      if (background) return { stdout: '', stderr: '', exitCode: command.exitCode, processId };
      const output = this.collect(command, limit, signal, false, redact);
      // Attach rejection handlers to both promises immediately.
      const [result, finished] = await Promise.all([output, command.wait({ signal })]);
      await this.active(signal);
      return { ...result, exitCode: finished.exitCode, processId };
    } catch (error) {
      // No cleanup effect from a cancelled/stale owner. The original remote timeout remains enforced.
      if (command) { try { await this.active(signal); await command.kill('SIGKILL', { abortSignal: signal }); } catch { /* Do not dispatch after cancellation. */ } }
      if (error instanceof WorkspaceError) { error.effectStarted = dispatched; throw error; }
      return fail(signal?.aborted ? 'ABORTED' : 'COMMAND_FAILED', signal?.aborted ? 'Workspace operation was cancelled.' : 'Workspace command could not be completed.');
    }
  }

  async file(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    workspacePath(String(input.path ?? '.'));
    const payload = JSON.stringify({ ...input, root: WORKSPACE_ROOT });
    const output = await this.run('python3', ['-I', '-S', '-c', WORKSPACE_FILE_PROGRAM,
      ...(payload.match(/[\s\S]{1,16000}/g) ?? [])], 30_000, signal, false, MAX_FILE_BYTES * 6 + 1024, false, false);
    try { await this.active(signal); }
    catch (error) { if (error instanceof WorkspaceError) error.effectStarted = true; throw error; }
    if (output.exitCode !== 0 || output.truncated) return fail('FILE_OPERATION_FAILED', 'Workspace file helper failed.');
    const redact = (value: unknown): unknown => typeof value === 'string' ? redactWorkspaceOutput(value, this.sensitive)
      : Array.isArray(value) ? value.map(redact) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) : value;
    return redact(parseWorkspaceFileResult(output.stdout)) as Record<string, unknown>;
  }
  async readFile(path: string, signal?: AbortSignal): Promise<string> {
    const result = await this.file({ op: 'read', path: workspacePath(path) }, signal);
    await this.active(signal);
    if (typeof result.content !== 'string') return fail('FILE_OPERATION_FAILED', 'Workspace file helper returned invalid content.');
    return result.content;
  }
  async writeFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) return fail('FILE_TOO_LARGE', 'File exceeds the workspace file size limit.');
    await this.file({ op: 'write', path: workspacePath(path), content }, signal);
    try { await this.active(signal); }
    catch (error) { if (error instanceof WorkspaceError) error.effectStarted = true; throw error; }
  }
  async exec(input: CommandInput, signal?: AbortSignal): Promise<CommandOutput> {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 64 * 1024 || input.command.includes('\0')) {
      return fail('INVALID_COMMAND', 'A nonempty bounded shell command is required.');
    }
    const timeout = input.timeoutMs ?? MAX_COMMAND_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_COMMAND_MS) return fail('INVALID_TIMEOUT', 'Command timeout must be between 1 and 120000 milliseconds.');
    if (input.useRuntimeEnvironment && Object.keys(this.environment).length === 0) {
      return fail('RUNTIME_ENVIRONMENT_UNAVAILABLE', 'Host runtime environment is not configured in this slice. Configure the application capability before opting in.');
    }
    return this.run('python3', ['-I', '-S', '-c', WORKSPACE_FILE_PROGRAM, JSON.stringify({ op: 'exec',
      root: WORKSPACE_ROOT, path: workspacePath(input.cwd ?? '.'), command: input.command })], timeout, signal, input.background, MAX_COMMAND_OUTPUT, input.useRuntimeEnvironment);
  }
  private commandId(id: string): string {
    if (!id.startsWith(`${this.ref.id}:`) || !/^[A-Za-z0-9_-]{1,150}$/.test(id.slice(this.ref.id.length + 1))) {
      return fail('INVALID_PROCESS_ID', 'Process does not belong to this workspace.');
    }
    return id.slice(this.ref.id.length + 1);
  }
  async processStatus(id: string, signal?: AbortSignal): Promise<CommandOutput> {
    signal = this.signal(signal);
    const cmdId = this.commandId(id);
    try {
      await this.active(signal);
      const command = await this.sandbox.getCommand(cmdId, { signal });
      await this.active(signal);
      const output = await this.collect(command, MAX_COMMAND_OUTPUT, signal, command.exitCode === null);
      await this.active(signal);
      return { ...output, processId: id };
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      return fail('PROCESS_UNAVAILABLE', 'Process is unavailable in the current VM session; it was not restarted.');
    }
  }
  async stopProcess(id: string, signal?: AbortSignal): Promise<void> {
    signal = this.signal(signal);
    const cmdId = this.commandId(id);
    let dispatched = false;
    try {
      await this.active(signal);
      const command = await this.sandbox.getCommand(cmdId, { signal });
      await this.active(signal);
      dispatched = true;
      await command.kill('SIGKILL', { abortSignal: signal });
      await this.active(signal);
    } catch (error) {
      if (error instanceof WorkspaceError) { error.effectStarted = dispatched; throw error; }
      return fail('PROCESS_UNAVAILABLE', 'Process could not be stopped in the current VM session.');
    }
  }
  async suspend(): Promise<void> {
    const signal = this.signal(AbortSignal.timeout(60_000));
    try { await this.active(signal); await this.sandbox.stop({ signal }); await this.active(signal); }
    catch (error) {
      if (error instanceof WorkspaceError) throw error;
      return fail('WORKSPACE_SUSPEND_FAILED', 'Workspace snapshot could not be saved.');
    }
  }
}

/** Host-fenced adoption of an existing requirement workspace. Never clone/reset it.
 * Owner must prove its site/requirement binding before calling; repository identity
 * and existing session tags are checked again here. No model-selected sandbox ID. */
export async function adoptRequirementWorkspace(input: {
  sessionId: string; workspaceId: string; repository: { url: string; ref?: string };
  /** Host-confirmed prior terminal occurrence of this same requirement only. */
  previousSessionId?: string;
  assertActive: AssertActive; signal?: AbortSignal; host?: WorkspaceHostOptions;
}): Promise<Workspace> {
  const active = () => checkActive(input.assertActive, input.signal);
  const url = validateWorkspaceRepository(input.repository);
  await active();
  const sandbox = await Sandbox.get({ name: input.workspaceId, resume: false, signal: input.signal });
  await active();
  if (sandbox.tags?.harnessSession && sandbox.tags.harnessSession !== input.sessionId &&
    sandbox.tags.harnessSession !== input.previousSessionId) throw new WorkspaceError('WORKSPACE_SCOPE_MISMATCH', 'Workspace belongs to another agent session');
  if (['stopped', 'failed', 'aborted'].includes(sandbox.status) && !sandbox.currentSnapshotId) throw new WorkspaceError('WORKSPACE_SNAPSHOT_MISSING', 'Existing work cannot be restored; no clean replacement was created');
  const sensitive = [...(input.host?.redactionValues || []), ...runtimeSecretValues(input.host?.environment || {})];
  if (input.host?.git) sensitive.push(input.host.git.password, input.host.git.username,
    Buffer.from(`${input.host.git.username}:${input.host.git.password}`).toString('base64'));
  const workspace = new VercelWorkspace(sandbox, sensitive, runtimeEnvironment(input.host?.environment), input.assertActive, input.signal);
  const remote = await workspace.exec({ command: 'git -c core.fsmonitor=false config --local --get remote.origin.url', timeoutMs: 10000 }, input.signal);
  if (remote.exitCode !== 0) throw new WorkspaceError('WORKSPACE_SCOPE_MISMATCH', 'Existing workspace has no repository binding');
  let origin: URL;
  try { origin = new URL(remote.stdout.trim()); } catch { throw new WorkspaceError('WORKSPACE_SCOPE_MISMATCH', 'Invalid existing repository origin'); }
  if (origin.origin !== url.origin || origin.pathname.replace(/\.git$/, '') !== url.pathname.replace(/\.git$/, '')) {
    throw new WorkspaceError('WORKSPACE_SCOPE_MISMATCH', 'Existing repository does not match requirement');
  }
  await active();
  // Broker auth replaces historical credentialed URLs; no source files or commits are changed.
  const normalize = await workspace.exec({ command: `git config --local remote.origin.url ${shellQuote(url.href)}`, timeoutMs: 10000 }, input.signal);
  if (normalize.exitCode !== 0) throw new WorkspaceError('WORKSPACE_SCOPE_MISMATCH', 'Could not normalize existing origin');
  await active();
  await sandbox.update({ networkPolicy: workspaceNetworkPolicy(url, input.host?.git), tags: {
    harnessSession: input.sessionId, harnessRepository: createHash('sha256').update(JSON.stringify([url.href, input.repository.ref ?? null])).digest('hex'), harnessReady: 'true',
  } }, { signal: input.signal });
  await active();
  adapters.set(workspace, workspace);
  return workspace;
}

export async function openWorkspace(input: {
  sessionId: string;
  repository: { url: string; ref?: string };
  existing?: WorkspaceRef;
  signal?: AbortSignal;
  host?: WorkspaceHostOptions;
  /** Runtime must fence the lease owner; optional only for offline library callers. */
  assertActive?: AssertActive;
}): Promise<Workspace> {
  if (!uuid.test(input.sessionId)) return fail('INVALID_SESSION_ID', 'Workspace session ID must be a UUID.');
  const name = `h-${input.sessionId.toLowerCase()}`;
  const url = validateWorkspaceRepository(input.repository);
  const environment = runtimeEnvironment(input.host?.environment);
  const networkPolicy = workspaceNetworkPolicy(url, input.host?.git);
  if (input.existing && (input.existing.provider !== 'vercel' || input.existing.id !== name || input.existing.root !== WORKSPACE_ROOT)) {
    return fail('WORKSPACE_SCOPE_MISMATCH', 'Workspace reference does not belong to this session.');
  }
  const tags = { harnessSession: input.sessionId.toLowerCase(),
    harnessRepository: createHash('sha256').update(JSON.stringify([url.href, input.repository.ref ?? null])).digest('hex') };
  const git = input.host?.git;
  const sensitive = git ? [git.username, git.password, Buffer.from(`${git.username}:${git.password}`).toString('base64'),
    encodeURIComponent(git.username), encodeURIComponent(git.password)] : [];
  sensitive.push(...runtimeSecretValues(environment), ...(input.host?.redactionValues ?? []));
  const assertActive = input.assertActive ?? noopActive;
  const active = () => checkActive(assertActive, input.signal);
  let sandbox: Sandbox;
  let created = false;
  try {
    try { await active(); sandbox = await Sandbox.get({ name, resume: false, signal: input.signal }); await active(); }
    catch (error) {
      await active();
      const missing = error && typeof error === 'object' && 'response' in error &&
        (error.response as { status?: number })?.status === 404;
      if (input.existing || !missing) throw error;
      // No getOrCreate with setup callbacks: an existing/incomplete VM is NEVER reset.
      await active();
      sandbox = await Sandbox.create({ name, persistent: true, image: 'vercel/sandbox/universal',
        timeout: 30 * 60_000, env: {}, ports: [], networkPolicy, tags,
        keepLastSnapshots: { count: 2 }, signal: input.signal });
      await active();
      created = true;
    }
    if (!created && (sandbox.name !== name || !sandbox.persistent || sandbox.tags?.harnessSession !== tags.harnessSession ||
        sandbox.tags?.harnessRepository !== tags.harnessRepository)) {
      return fail('WORKSPACE_NOT_READY', 'Existing workspace does not match this session and repository; no files were reset.');
    }
    if (!created && ['stopped', 'failed', 'aborted'].includes(sandbox.status) && !sandbox.currentSnapshotId) {
      return fail('WORKSPACE_SNAPSHOT_MISSING', 'Existing workspace has no restorable snapshot; it was not restarted from a clean image.');
    }
    await active();
    await sandbox.update({ networkPolicy }, { signal: input.signal });
    await active();
    const workspace = new VercelWorkspace(sandbox, sensitive, environment, assertActive, input.signal);
    adapters.set(workspace, workspace);
    if (created || sandbox.tags?.harnessReady !== 'true') {
      const result = await workspace.bootstrap({ sessionId: tags.harnessSession, repository: tags.harnessRepository,
        url: url.href, ref: input.repository.ref }, input.signal);
      await active();
      if (result.exitCode !== 0) return fail(result.exitCode === 128 ? 'REPOSITORY_CLONE_FAILED' : 'WORKSPACE_NOT_READY',
        'Repository bootstrap could not complete safely. Existing work and incomplete staging were preserved.');
      await active();
      await sandbox.update({ tags: { ...tags, harnessReady: 'true' } }, { signal: input.signal });
      await active();
    }
    await active();
    return workspace;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    return fail(input.signal?.aborted ? 'ABORTED' : 'WORKSPACE_OPEN_FAILED', input.signal?.aborted
      ? 'Workspace opening was cancelled.' : 'Workspace could not be opened. Existing state was not recreated or reset.');
  }
}