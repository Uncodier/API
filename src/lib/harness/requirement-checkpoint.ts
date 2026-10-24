import { createHash } from 'node:crypto';
import { branchBelongsToRequirement } from '../services/requirement-branch';
import { sourceExportRisk } from './export-policy';
import { createRedactor } from './security';
import { shellQuote, workspacePath, WorkspaceError } from './workspace';
import type { Workspace } from './types';
import type { RequirementRun } from './requirement-types';

/** Private, host-persisted receipt. NEVER accept this baseline from model/tool arguments. */
export interface RequirementCheckpointBaseline {
  version: 1;
  repositoryUrl: string;
  branch: string;
  workspaceId: string;
  headSha: string;
  commitSha: string;
  /** Last observed safe LOCAL contents, not the merged remote tree. */
  files: Record<string, string>;
}

export interface RequirementCheckpointResult {
  state: 'saved' | 'unchanged' | 'skipped' | 'failed' | 'unknown';
  sha?: string;
  repoUrl?: string;
  reason?: string;
  excludedCount?: number;
  baseline?: RequirementCheckpointBaseline;
}

/** Durable host-only write-ahead intent, persisted BEFORE updating the GitHub ref. */
export interface RequirementCheckpointPublicationIntent {
  baseline: RequirementCheckpointBaseline;
  parentSha: string;
  expectedSha: string;
  createRef: boolean;
}

export interface RequirementCheckpointOptions {
  run: RequirementRun;
  workspace: Workspace;
  repositoryUrl: string;
  branch: string;
  /** Already repository/site-bound by the host profile resolver. No environment fallback. */
  git?: { username: string; password: string; allowPush: boolean };
  redact: (text: string) => string;
  assertActive: () => Promise<void>;
  signal: AbortSignal;
  baseline?: RequirementCheckpointBaseline;
  pendingPublication?: RequirementCheckpointPublicationIntent;
  /** Required to publish. Hosts persist separately from the last confirmed receipt. */
  preparePublication?: (intent: RequirementCheckpointPublicationIntent) => Promise<void>;
  /** Host-configured clone/base ref, used only when the requirement branch is absent. */
  baseRef?: string;
}

const SHA = /^[a-f0-9]{40}$/;
const MAX_PATHS = 20000;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;
const LISTING_PAGE_BYTES = 32 * 1024;
const MAX_UPDATES = 200;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const excluded = /(?:^|\/)(?:node_modules|\.next|\.venv|venv|dist|build|coverage|__pycache__|\.gitmodules|\.gitattributes|\.gitignore|\.github|\.gitlab|\.husky|hooks|\.gitconfig)(?:\/|$)/i;
// No credentials, repo commands, hooks, filters, textconv, or local commit objects are exported.
const GIT = '/usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 /usr/bin/git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.helper= -c protocol.allow=never';
// Trusted isolated helper: bounded subprocess output, no shell, imports from the
// repository, hooks, filters, textconv, or temporary files. Re-enumeration pages
// carry a whole-stream digest so a changing index cannot silently splice pages.
const LISTING_PROGRAM = String.raw`
import sys, subprocess, hashlib, base64, json, os, stat, re
p = json.loads(sys.argv[1])
child = subprocess.Popen(p['argv'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={})
data = bytearray()
try:
    while True:
        chunk = child.stdout.read(32768)
        if not chunk: break
        data.extend(chunk)
        if len(data) > 8388608: raise ValueError('listing_limit')
    if child.wait() != 0: raise ValueError('listing_failed')
    if p['changed']:
        changed = bytearray()
        budget = 64 * 1024 * 1024
        root = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for row in data.split(b'\0'):
                if not row: continue
                meta, path = row.split(b'\t', 1)
                mode, oid, stage = meta.split(b' ')
                # No path is followed. Unsafe/oversized files remain candidates
                # for the workspace safe reader to reject, not deletion proof.
                candidate = True
                fd = os.dup(root)
                try:
                    parts = path.decode('utf-8').split('/')
                    if any(not x or x in ('.', '..') or re.search(r'[\x00-\x1f\x7f\\]', x) for x in parts): raise ValueError('path')
                    if re.search(p['excluded'], '/'.join(parts), re.I) or any(re.search(p['secret'], x, re.I) for x in parts): raise ValueError('excluded')
                    for part in parts[:-1]:
                        new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        os.close(fd)
                        fd = new
                    leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        info = os.fstat(leaf)
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 262144 or info.st_size > budget: raise ValueError('file')
                        raw = bytearray()
                        while len(raw) <= 262144:
                            chunk = os.read(leaf, min(32768, 262145-len(raw)))
                            if not chunk: break
                            raw.extend(chunk)
                        budget -= len(raw)
                        if len(raw) <= 262144:
                            candidate = hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest().encode() != oid
                    finally: os.close(leaf)
                except (OSError, ValueError, UnicodeError): pass
                finally: os.close(fd)
                if candidate: changed.extend(path+b'\0')
        finally: os.close(root)
        data = changed
    offset = p['offset']
    print(json.dumps({'total': len(data), 'digest': hashlib.sha256(data).hexdigest(),
        'data': base64.b64encode(data[offset:offset+32768]).decode('ascii')}))
finally:
    if child.poll() is None: child.kill()
    child.wait()
`;
type Entry = { path: string; sha: string; mode: string; type: string };
type Update = { path: string; mode: string; type: 'blob'; content?: string; sha?: null };
class Stop extends Error { constructor(readonly reason: string) { super(reason); } }
class HttpFailure extends Error { constructor(readonly status: number) { super('github_request_failed'); } }
const blobSha = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const regular = (entry?: Entry): entry is Entry => !!entry && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode);
const same = (a?: Entry, b?: Entry) => a?.sha === b?.sha && a?.mode === b?.mode && a?.type === b?.type;

/**
 * Host Git Data API checkpoint, NOT git push. Local HEAD is only an ancestry candidate;
 * all commit/tree ancestry comes from GitHub. The sandbox index supplies names/modes
 * only, never content. No worktree/index/ref writes, DB writes, builds or resets.
 * [skip ci] is advisory: GitHub integrations may still trigger deployments.
 */
export async function checkpointRequirementWorkspace(options: RequirementCheckpointOptions): Promise<RequirementCheckpointResult> {
  const { workspace, run, branch, signal } = options;
  let excludedCount = 0;
  let refAttempted = false;
  let expectedSha: string | undefined;
  let repoUrl: string | undefined;
  let nextBaseline: RequirementCheckpointBaseline | undefined;
  let readRef: (() => Promise<string>) | undefined;
  const credentialRedactor = createRedactor([options.git?.username || '', options.git?.password || '']);
  const redact = (text: string) => credentialRedactor(options.redact(text));
  const result = (state: RequirementCheckpointResult['state'], reason: string): RequirementCheckpointResult => ({ state, reason, excludedCount });
  const active = async () => { signal.throwIfAborted(); await options.assertActive(); signal.throwIfAborted(); };
  const safePath = (path: string) => {
    if (!path || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..') || excluded.test(path)) return false;
    try { workspacePath(path, workspace.ref.root); return redact(path) === path && !path.includes('[REDACTED'); } catch { return false; }
  };
  try {
    await active();
    if (!options.git?.allowPush || !options.git.username || !options.git.password) return result('skipped', 'host_push_not_authorized');
    // Strict canonical host input, not URLs obtained from sandbox git config.
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(options.repositoryUrl);
    if (!match || ['.', '..'].includes(match[2])) return result('skipped', 'invalid_host_repository');
    if (redact(options.repositoryUrl) !== options.repositoryUrl || redact(branch) !== branch) return result('skipped', 'unsafe_repository_identity');
    if (!branchBelongsToRequirement(branch, run.requirementId) || branch.length > 240 ||
        !/^[A-Za-z0-9_./-]+$/.test(branch) || branch.includes('..') || branch.includes('//') ||
        branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
      return result('skipped', 'invalid_requirement_branch');
    }
    const repositoryUrl = `https://github.com/${match[1]}/${match[2]}`;
    const recoveryUrl = (sha: string) => `${repositoryUrl}/tree/${sha}`;
    const api = `https://api.github.com/repos/${match[1]}/${match[2]}`;
    const request = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
      await active();
      const response = await fetch(api + path, { method, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: { Authorization: `Bearer ${options.git!.password}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new HttpFailure(response.status);
      const value = await response.json();
      await active();
      return value;
    };
    const exec = async (args: string, raw = false) => {
      await active();
      const value = await workspace.exec({ command: raw ? args : `${GIT} ${args}`, timeoutMs: 10000 }, signal);
      await active();
      if (value.exitCode !== 0 || value.truncated || typeof value.stdout !== 'string' || Buffer.byteLength(value.stdout) > 64 * 1024) throw new Stop('workspace_capture_unavailable');
      return value.stdout;
    };
    const list = async (args: string, changed = false) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let digest = '';
      for (let offset = 0; offset === 0 || offset < total; offset += LISTING_PAGE_BYTES) {
        const command = `/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/python3 -I -S -c ${shellQuote(LISTING_PROGRAM)} ${shellQuote(JSON.stringify({ argv: `${GIT} ${args}`.split(' '), offset, changed,
          excluded: excluded.source,
          secret: '^(?:\\.env(?:\\..*)?|\\.git|\\.ssh|\\.aws|\\.azure|\\.config|\\.kube|\\.gnupg|\\.npmrc|\\.pypirc|\\.netrc|\\.git-credentials|credentials(?:\\..*)?|secrets?(?:\\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\\..*)?)$|\\.(?:pem|key|p12|pfx|keystore)$' }))}`;
        const page = JSON.parse(await exec(command, true));
        if (!Number.isInteger(page.total) || page.total < 0 || page.total > MAX_LISTING_BYTES ||
            !/^[a-f0-9]{64}$/.test(page.digest) || typeof page.data !== 'string' ||
            (offset > 0 && (page.total !== total || page.digest !== digest))) throw new Stop('workspace_capture_incomplete');
        total = page.total; digest = page.digest;
        const chunk = Buffer.from(page.data, 'base64');
        if (chunk.length !== Math.min(LISTING_PAGE_BYTES, total - offset) || chunk.toString('base64') !== page.data) throw new Stop('workspace_capture_incomplete');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const text = data.toString('utf8');
      if (createHash('sha256').update(data).digest('hex') !== digest || !data.equals(Buffer.from(text))) throw new Stop('workspace_capture_incomplete');
      return text;
    };
    const refPath = `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
    readRef = async () => {
      const ref = await request(refPath);
      if (ref.ref !== `refs/heads/${branch}` || ref.object?.type !== 'commit' || !SHA.test(ref.object.sha)) throw new Stop('invalid_remote_ref');
      return ref.object.sha as string;
    };
    const validateBaseline = (value: RequirementCheckpointBaseline) => {
      if (value.version !== 1 || value.repositoryUrl !== repositoryUrl || value.branch !== branch ||
          value.workspaceId !== workspace.ref.id || !SHA.test(value.headSha) || !SHA.test(value.commitSha) ||
          !value.files || Object.keys(value.files).length > MAX_PATHS ||
          Object.entries(value.files).some(([path, sha]) => !safePath(path) || typeof sha !== 'string' || !SHA.test(sha))) throw new Stop('baseline_identity_mismatch');
    };
    const ancestor = async (base: string, tip: string, reason: string) => {
      if (base === tip) return;
      const compare = await request(`/compare/${base}...${tip}`);
      if (!['ahead', 'identical'].includes(compare.status) || compare.merge_base_commit?.sha !== base) throw new Stop(reason);
    };
    let previous = options.baseline;
    if (previous) validateBaseline(previous);
    let remoteSha: string | undefined;
    try { remoteSha = await readRef(); }
    catch (error) { if (!(error instanceof HttpFailure) || error.status !== 404) throw error; }
    // Reconcile durable intent before touching HEAD or reading a fresh capture.
    // Commit messages and local history are never evidence of publication.
    const pending = options.pendingPublication;
    if (pending) {
      validateBaseline(pending.baseline);
      if (!SHA.test(pending.parentSha) || !SHA.test(pending.expectedSha) ||
          pending.baseline.commitSha !== pending.expectedSha || typeof pending.createRef !== 'boolean') throw new Stop('pending_publication_invalid');
      if (remoteSha === pending.expectedSha) previous = pending.baseline;
      else if ((!pending.createRef && remoteSha === pending.parentSha) || (pending.createRef && !remoteSha)) {
        // Definitely not applied: retain the last confirmed baseline. A future
        // publication will overwrite the intent before changing any ref.
      } else if (remoteSha) {
        await ancestor(pending.expectedSha, remoteSha, 'pending_publication_conflict');
        previous = pending.baseline;
      } else throw new Stop('pending_publication_conflict');
    }
    let createRef = false;
    if (!remoteSha) {
      if (previous) throw new Stop('remote_baseline_unavailable');
      const baseRef = options.baseRef || 'main';
      if (!/^[A-Za-z0-9_/-]+$/.test(baseRef) || baseRef.length > 240 || baseRef.includes('//')) throw new Stop('invalid_base_ref');
      const ref = await request(`/git/ref/heads/${baseRef.split('/').map(encodeURIComponent).join('/')}`);
      if (ref.ref !== `refs/heads/${baseRef}` || ref.object?.type !== 'commit' || !SHA.test(ref.object.sha)) throw new Stop('invalid_remote_ref');
      remoteSha = ref.object.sha as string;
      createRef = true;
    }
    const headSha = (await exec('rev-parse --verify HEAD^{commit}')).trim();
    if (!SHA.test(headSha) || (await exec('symbolic-ref --quiet --short HEAD')).trim() !== branch) return result('skipped', 'workspace_branch_mismatch');
    const baseSha = previous?.commitSha || headSha;
    await ancestor(baseSha, remoteSha, 'baseline_not_remote_ancestor');
    if (previous && previous.headSha !== headSha) {
      await ancestor(previous.headSha, headSha, 'workspace_head_not_descendant');
      await ancestor(headSha, remoteSha, 'workspace_head_not_remote_ancestor');
    }
    const listing = await list('ls-files --cached --others --exclude-standard -z');
    if (listing && !listing.endsWith('\0')) throw new Stop('workspace_capture_incomplete');
    const paths = [...new Set(listing.split('\0').filter(Boolean))].sort();
    if (paths.length > MAX_PATHS) throw new Stop('workspace_capture_limit');
    // Git's --modified can execute repository clean filters. Use only staged
    // names/OIDs plus isolated descriptor-relative raw hashing, never filters.
    const changedListing = await list('ls-files --stage -z', true);
    if (changedListing && !changedListing.endsWith('\0')) throw new Stop('workspace_capture_incomplete');
    const candidates = new Set(changedListing.split('\0').filter(Boolean));
    const staged = await list('ls-files --stage -z');
    if (staged && !staged.endsWith('\0')) throw new Stop('workspace_capture_incomplete');
    const index = new Map<string, Entry>();
    const submodules = new Set<string>();
    for (const row of staged.split('\0').filter(Boolean)) {
      const item = /^(\d{6}) ([a-f0-9]{40}) ([0-3])\t(.+)$/.exec(row);
      if (!item || item[3] !== '0') throw new Stop('workspace_index_unmerged');
      if (item[1] === '160000') submodules.add(item[4]);
      index.set(item[4], { path: item[4], mode: item[1], sha: item[2], type: 'blob' });
    }
    for (const path of paths) if (!index.has(path)) candidates.add(path);
    const flags = await list('ls-files -v -z');
    if (flags && !flags.endsWith('\0')) throw new Stop('workspace_capture_incomplete');
    const normallyTracked = new Set(flags.split('\0').filter(row => row.startsWith('H ')).map(row => row.slice(2)));
    const loadTree = async (sha: string) => {
      const commit = await request(`/git/commits/${sha}`);
      if (commit.sha !== sha || !SHA.test(commit.tree?.sha)) throw new Stop('invalid_remote_commit');
      const response = await request(`/git/trees/${commit.tree.sha}?recursive=1`);
      if (response.truncated !== false || !Array.isArray(response.tree) || response.tree.length > MAX_PATHS) throw new Stop('remote_tree_limit');
      const tree = new Map<string, Entry>();
      for (const entry of response.tree) {
        if (typeof entry.path !== 'string' || !SHA.test(entry.sha) || !['blob', 'tree', 'commit'].includes(entry.type) || tree.has(entry.path)) throw new Stop('invalid_remote_tree');
        tree.set(entry.path, entry);
        if (entry.type === 'commit' || entry.mode === '160000') submodules.add(entry.path);
      }
      return { treeSha: commit.tree.sha as string, tree };
    };
    const remote = await loadTree(remoteSha);
    const base = baseSha === remoteSha ? remote : await loadTree(baseSha);
    const head = headSha === baseSha ? base : headSha === remoteSha ? remote : await loadTree(headSha);
    const localBase = previous ? new Map(Object.entries(previous.files)) : new Map([...base.tree].filter(([path, entry]) => safePath(path) && regular(entry)).map(([path, entry]) => [path, entry.sha]));
    const headChanges = new Set<string>();
    if (previous && previous.headSha !== headSha) {
      const oldHead = previous.headSha === baseSha ? base : await loadTree(previous.headSha);
      for (const path of new Set([...oldHead.tree.keys(), ...head.tree.keys()])) {
        if (!same(oldHead.tree.get(path), head.tree.get(path))) {
          headChanges.add(path);
          const atHead = head.tree.get(path);
          if (safePath(path) && regular(atHead)) localBase.set(path, atHead.sha);
          else localBase.delete(path);
        }
      }
    }
    const files: Record<string, string> = Object.create(null);
    const updates: Update[] = [];
    let bytes = 0;
    const blocked = (path: string) => !safePath(path) || [...submodules].some(p => path === p || path.startsWith(p + '/'));
    for (const path of paths) {
      signal.throwIfAborted();
      if (blocked(path) || (index.has(path) && !regular(index.get(path)))) { excludedCount++; continue; }
      // Only paths actually changed by a GitHub-verified HEAD advance acquire
      // that new merge base. Resetting the entire local manifest would turn
      // stale local files into reverts of remote-only edits.
      const before = (headChanges.has(path) ? head : base).tree.get(path);
      const current = remote.tree.get(path);
      const atHead = head.tree.get(path);
      // Staged changes may look clean to --modified; compare only their OIDs to
      // GitHub's verified HEAD. The index never supplies published contents.
      if (!candidates.has(path) && regular(atHead) && same(index.get(path), atHead) &&
          (!previous || localBase.get(path) === atHead.sha)) {
        files[path] = atHead.sha;
        continue;
      }
      let content: string;
      await active();
      try { content = await workspace.readFile(path, signal); }
      catch (error) {
        await active();
        // Staged removals, unsafe reads and absent unknown files are NOT deletion proof.
        if (!(error instanceof WorkspaceError) || error.code !== 'FILE_NOT_FOUND' || !normallyTracked.has(path) || !regular(before) ||
            localBase.get(path) !== before.sha || !same(index.get(path), before) || !same(current, before)) { excludedCount++; continue; }
        const blob = await request(`/git/blobs/${before.sha}`);
        if (blob.sha !== before.sha || blob.encoding !== 'base64' || !Number.isInteger(blob.size) || blob.size > MAX_FILE_BYTES ||
            typeof blob.content !== 'string' || blob.content.length > MAX_FILE_BYTES * 2) { excludedCount++; continue; }
        const raw = Buffer.from(blob.content, 'base64');
        const oldContent = raw.toString('utf8');
        if (raw.length !== blob.size || !raw.equals(Buffer.from(oldContent)) || oldContent.includes('\0') ||
            blobSha(oldContent) !== before.sha || sourceExportRisk(path, oldContent, redact)) { excludedCount++; continue; }
        updates.push({ path, mode: before.mode, type: 'blob', sha: null });
        continue;
      }
      await active();
      if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) ||
          Buffer.from(content).toString('utf8') !== content || sourceExportRisk(path, content, redact)) { excludedCount++; continue; }
      bytes += Buffer.byteLength(content);
      if (bytes > MAX_BYTES) throw new Stop('workspace_capture_limit');
      const sha = blobSha(content);
      files[path] = sha;
      if (localBase.get(path) === sha || (regular(current) && current.sha === sha)) continue;
      // A prior checkpoint may have preserved a remote-only edit while the local
      // worktree stayed stale. A later local edit still conflicts with that edit.
      if (previous && before?.sha !== localBase.get(path)) throw new Stop('remote_workspace_conflict');
      if (!same(current, before)) throw new Stop('remote_workspace_conflict');
      if ((current && !regular(current)) || [...remote.tree].some(([p, e]) =>
        (path.startsWith(p + '/') && e.type !== 'tree') || p.startsWith(path + '/'))) throw new Stop('remote_path_conflict');
      updates.push({ path, mode: regular(current) ? current.mode : '100644', type: 'blob', content });
    }
    // Unlisted baseline files cannot establish deletion (e.g. git rm --cached / ignore).
    excludedCount += [...localBase.keys()].filter(path => !paths.includes(path)).length;
    if (updates.length > MAX_UPDATES) throw new Stop('checkpoint_update_limit');
    nextBaseline = { version: 1, repositoryUrl, branch, workspaceId: workspace.ref.id, headSha, commitSha: remoteSha, files };
    if (!updates.length && !createRef) return { state: 'unchanged', sha: remoteSha, repoUrl: recoveryUrl(remoteSha), excludedCount, baseline: nextBaseline };
    if (!options.preparePublication) throw new Stop('publication_journal_required');
    // A capture racing a local checkout is not a coherent source snapshot.
    if ((await exec('rev-parse --verify HEAD^{commit}')).trim() !== headSha ||
        (await exec('symbolic-ref --quiet --short HEAD')).trim() !== branch) throw new Stop('workspace_changed_during_capture');
    expectedSha = remoteSha;
    if (updates.length) {
      const tree = await request('/git/trees', 'POST', { base_tree: remote.treeSha, tree: updates });
      if (!SHA.test(tree.sha)) throw new Stop('invalid_created_tree');
      const commit = await request('/git/commits', 'POST', { message: 'Requirement workspace checkpoint [skip ci]', tree: tree.sha, parents: [remoteSha] });
      if (!SHA.test(commit.sha)) throw new Stop('invalid_created_commit');
      expectedSha = commit.sha;
    }
    // GitHub force:false provides atomic fast-forward enforcement against concurrent writers.
    repoUrl = recoveryUrl(expectedSha!);
    nextBaseline.commitSha = expectedSha!;
    await active();
    await options.preparePublication({ baseline: nextBaseline, parentSha: remoteSha, expectedSha: expectedSha!, createRef });
    await active();
    refAttempted = true;
    if (createRef) await request('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: expectedSha });
    else await request(refPath.replace('/git/ref/', '/git/refs/'), 'PATCH', { sha: expectedSha, force: false });
    if (await readRef() !== expectedSha) return result('unknown', 'ref_update_not_verified');
    nextBaseline.commitSha = expectedSha!;
    return { state: 'saved', sha: expectedSha, repoUrl, excludedCount, baseline: nextBaseline };
  } catch (error) {
    if (refAttempted && expectedSha && readRef) {
      try {
        if (await readRef() === expectedSha) {
          nextBaseline!.commitSha = expectedSha;
          return { state: 'saved', sha: expectedSha, repoUrl, excludedCount, baseline: nextBaseline };
        }
        if (error instanceof HttpFailure && [409, 422].includes(error.status)) return result('skipped', 'remote_ref_conflict');
      } catch { /* Do not bypass lease/cancellation to reconcile an ambiguous write. */ }
      return result('unknown', 'ref_update_not_verified');
    }
    if (error instanceof Stop) return result('skipped', error.reason);
    if (signal.aborted) return result('skipped', 'checkpoint_cancelled');
    if (error instanceof HttpFailure && error.status === 404) return result('skipped', 'remote_baseline_unavailable');
    return result('failed', 'checkpoint_unavailable');
  }
}