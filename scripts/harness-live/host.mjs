import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const frontend = '/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit';
const require = createRequire(`${frontend}/package.json`);
const legacy = require(`${frontend}/scripts/harness-e2e/host.cjs`);
const { parse } = require('dotenv');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const marker = 'existing-app-live-v1';
export function identity(runId, name) { return require(`${frontend}/scripts/harness-e2e/cases.cjs`).fixtureId(runId, `live:${name}`); }
export async function connect() {
  const settings = legacy.config();
  const connection = await legacy.connect(settings);
  const api = parse(readFileSync(`${settings.apiRoot}/.env.local`));
  const cli = JSON.parse(readFileSync('/Users/prado/Library/Application Support/com.vercel.cli/auth.json', 'utf8'));
  settings.credentials.token = process.env.HARNESS_E2E_SANDBOX_TOKEN || cli.token;
  if (!api.GITHUB_TOKEN || !settings.credentials.token) throw new Error('Live credentials unavailable');
  const session = await connection.client.auth.getSession();
  if (!session.data.session?.access_token) throw new Error('User authentication unavailable');
  const project = await fetch(`https://api.vercel.com/v9/projects/${settings.credentials.projectId}?teamId=${settings.credentials.teamId}`, {
    headers: { authorization: `Bearer ${settings.credentials.token}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!project.ok) throw new Error('Deployment identity unavailable');
  const details = await project.json();
  const deployment = details.targets?.production;
  if (details.name !== 'api' || !deployment?.url) throw new Error('Unexpected API deployment');
  // The immutable deployment URL can be protected by Vercel login. Use only the
  // exact verified production alias, never follow a credential-bearing redirect.
  if (!deployment.alias?.includes('api-uncodie.vercel.app')) throw new Error('Production alias unavailable');
  const origin = 'https://api-uncodie.vercel.app';
  return { ...connection, settings, gitToken: api.GITHUB_TOKEN, accessToken: session.data.session.access_token,
    origin, deploymentId: deployment.id, deployedSha: deployment.meta?.githubCommitSha ?? null };
}

export async function github(host, path, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/makinary/apps/${path}`, {
    method, headers: { authorization: `Bearer ${host.gitToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub operation unavailable (${response.status})`);
  return response.json();
}

export async function seedBranch(host, branch, root, files) {
  if (!/^feature\/req-[a-f0-9-]{36}$/.test(branch) || !/^\.harness-live\/[a-z0-9-]{8,80}$/.test(root)) throw new Error('Unsafe fixture scope');
  const base = await github(host, 'git/ref/heads/main');
  const commit = await github(host, `git/commits/${base.object.sha}`);
  const tree = await github(host, 'git/trees', 'POST', { base_tree: commit.tree.sha,
    tree: Object.entries(files).map(([name, content]) => {
      if (!/^[a-z][a-z.-]+$/.test(name) || typeof content !== 'string') throw new Error('Unsafe fixture file');
      return { path: `${root}/${name}`, mode: '100644', type: 'blob', content };
    }) });
  const fixture = await github(host, 'git/commits', 'POST', { message: `Isolated live harness fixture ${root}`, tree: tree.sha, parents: [base.object.sha] });
  // No updates to existing branches and no retry of ambiguous mutations.
  await github(host, 'git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: fixture.sha });
  return fixture.sha;
}

export async function readFiles(host, snapshot, root, names) {
  if (!snapshot.workspace?.id || snapshot.workspace.root !== '/vercel/sandbox') return null;
  const { Sandbox } = createRequire(`${host.settings.apiRoot}/package.json`)('@vercel/sandbox');
  try {
    const vm = await Sandbox.get({ name: snapshot.workspace.id, resume: false, ...host.settings.credentials, signal: AbortSignal.timeout(15000) });
    if (vm.status !== 'running' || vm.tags?.harnessSession !== snapshot.id) return null;
    const files = {};
    for (const name of names) {
      const stream = await vm.readFile({ path: `/vercel/sandbox/${root}/${name}` }, { signal: AbortSignal.timeout(10000) });
      if (!stream) return null;
      let bytes = 0; const chunks = [];
      for await (const chunk of stream) { bytes += Buffer.byteLength(chunk); if (bytes > 65536) throw new Error('File budget exceeded'); chunks.push(Buffer.from(chunk)); }
      files[name] = Buffer.concat(chunks).toString('utf8');
    }
    return files;
  } catch { return null; }
}

export async function submit(host, spec, run, signal) {
  const response = await fetch(`${host.origin}/api/robots/instance/assistant`, {
    method: 'POST', headers: { authorization: `Bearer ${host.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: spec.instanceId, site_id: run.siteId, message: spec.message,
      request_id: `${run.id}:${spec.id}`, execution_mode: 'direct', use_sdk_tools: true }),
    redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(480000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`Assistant intake unavailable (${response.status})`);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = '', accepted = null, completed = false, bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 2 * 1024 * 1024) throw new Error('Intake evidence budget exceeded');
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const line = frame.split('\n').find(value => value.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === 'accepted') { accepted = { actionId: event.user_log_id, workflowId: event.run_id }; spec.actionId = event.user_log_id; }
        if (event.type === 'error') throw new Error('Assistant turn did not complete; request will not be replayed');
        if (event.type === 'completed') completed = true;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!accepted || !completed) throw new Error('Assistant completion unconfirmed');
  return accepted;
}