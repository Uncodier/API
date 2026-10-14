import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveSandboxAuth, SandboxAuthConfigurationError } from '../sandbox-auth';
import { workspaceOpenFailure } from '../workspace-open-failure';

it('preserves OIDC by default even when unrelated Vercel deployment credentials exist', () => {
  expect(resolveSandboxAuth({ VERCEL_TOKEN: randomBytes(24).toString('hex'), VERCEL_TEAM_ID: 'team', VERCEL_PROJECT_ID: 'project' })).toEqual({});
  expect(resolveSandboxAuth({})).toEqual({});
});
it('passes only explicit complete host credentials without interpreting profile/model data', () => {
  const token = randomBytes(24).toString('hex');
  expect(resolveSandboxAuth({ HARNESS_SANDBOX_AUTH: 'access-token', VERCEL_TOKEN: token, VERCEL_TEAM_ID: 'team', VERCEL_PROJECT_ID: 'project' }))
    .toEqual({ token, teamId: 'team', projectId: 'project' });
  expect(resolveSandboxAuth({ HARNESS_SANDBOX_AUTH: 'access-token', HARNESS_SANDBOX_TOKEN: token,
    HARNESS_SANDBOX_TEAM_ID: 'isolated-team', HARNESS_SANDBOX_PROJECT_ID: 'isolated-project', VERCEL_PROJECT_ID: 'deployment-project' }))
    .toEqual({ token, teamId: 'isolated-team', projectId: 'isolated-project' });
});
it.each(['token', 'team', 'project', 'mode', 'whitespace'])('rejects invalid %s configuration without leaking credentials or selecting another project', missing => {
  const secret = randomBytes(24).toString('hex');
  const env = { HARNESS_SANDBOX_AUTH: 'access-token', VERCEL_TOKEN: secret, VERCEL_TEAM_ID: 'team', VERCEL_PROJECT_ID: 'project' };
  if (missing === 'token') env.VERCEL_TOKEN = '';
  if (missing === 'team') env.VERCEL_TEAM_ID = '';
  if (missing === 'project') env.VERCEL_PROJECT_ID = '';
  if (missing === 'mode') env.HARNESS_SANDBOX_AUTH = 'guess';
  if (missing === 'whitespace') env.VERCEL_TOKEN += '\n';
  let error;
  try { resolveSandboxAuth(env); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(SandboxAuthConfigurationError);
  expect(String(error)).not.toContain(secret);
  expect(workspaceOpenFailure(error).code).toBe('WORKSPACE_AUTH_CONFIGURATION_REQUIRED');
});
it('reproduces the installed SDK OIDC error and explicit-access behavior without network, dotenv or saved auth', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { randomBytes } from 'node:crypto';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { Sandbox } from '@vercel/sandbox';
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-auth-offline-'));
    try {
      process.chdir(dir); process.env.HOME = dir; process.env.XDG_CONFIG_HOME = dir;
      process.env.CI = '1'; process.env.NODE_ENV = 'production'; process.env.VERCEL_URL = 'offline.example.invalid';
      const token = randomBytes(24).toString('hex'); process.env.VERCEL_TOKEN = token;
      // A synthetic unexpired JWT avoids any refresh/read of saved auth. It lacks
      // the SDK-required project claims, exercising the real OIDC wrapper error.
      process.env.VERCEL_OIDC_TOKEN = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url'), randomBytes(32).toString('base64url')].join('.');
      let globalRequests = 0, explicitRequests = 0;
      globalThis.fetch = async () => { globalRequests++; throw new Error('Network forbidden'); };
      let oidc;
      try { await Sandbox.get({ name: 'offline', resume: false }); } catch (e) { oidc = { name: e.name, hasHttp: !!e.response }; }
      let explicit;
      try { await Sandbox.get({ name: 'offline', resume: false, token, teamId: 'team', projectId: 'project',
        fetch: async (_url, init) => { explicitRequests++; if (init.headers.Authorization !== 'Bearer '+token) throw new Error('Missing credential');
          return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Synthetic access denied' } }), { status: 403 }); } });
      } catch (e) { explicit = { status: e.response?.status }; }
      console.log(JSON.stringify({ oidc, explicit, globalRequests, explicitRequests }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', CI: '1' } });
  const result = JSON.parse(output);
  expect(result).toEqual({ oidc: { name: 'VercelOidcContextError', hasHttp: false }, explicit: { status: 403 }, globalRequests: 0, explicitRequests: 1 });
  expect(workspaceOpenFailure(result.oidc).code).toBe('WORKSPACE_AUTH_CONFIGURATION_REQUIRED');
});