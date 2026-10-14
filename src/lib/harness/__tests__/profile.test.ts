import { randomBytes, randomUUID } from 'node:crypto';
import { resolveHostProfile } from '../profile';
import { createMemorySessionStore } from '../memory-store';
import { createSession, sessionRequestSchema } from '../session';

const siteId = randomUUID(); const userId = randomUUID();
const repositoryUrl = 'https://repo.example.invalid/team/project.git';
const env = (profiles: unknown): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', HARNESS_V2_PROFILES: JSON.stringify(profiles) });
it('resolves only an exact host-owned site/repository profile and defaults push off', () => {
  const password = randomBytes(24).toString('hex');
  const config = env({ project: { siteId, userId, repositoryUrl, allowed: ['sandbox_db_provision'], git: { username: 'git', password } } });
  const profile = resolveHostProfile('project', siteId, repositoryUrl, config);
  expect(profile?.git?.allowPush).toBe(false);
  expect(() => resolveHostProfile('project', randomUUID(), repositoryUrl, config)).toThrow('does not authorize');
  expect(() => resolveHostProfile('project', siteId, 'https://repo.example.invalid/other.git', config)).toThrow('does not authorize');
  expect(() => resolveHostProfile('missing', siteId, repositoryUrl, config)).toThrow('unavailable');
});
it('rejects platform credential environment and shared legacy binding aliases', () => {
  const secret = randomBytes(24).toString('hex');
  expect(() => resolveHostProfile('project', siteId, repositoryUrl, env({ project: {
    siteId, userId, repositoryUrl, environment: { SUPABASE_SERVICE_ROLE_KEY: secret },
  } }))).toThrow('Control-plane secrets');
  const requirementId = randomUUID();
  const shared = { siteId, userId, repositoryUrl, requirementId };
  expect(() => resolveHostProfile('a', siteId, repositoryUrl, env({ a: shared, b: shared }))).toThrow('multiple');
});
it('serializes a shared infrastructure profile for the entire resumable session lifetime', async () => {
  const store = createMemorySessionStore();
  const request = sessionRequestSchema.parse({ objective: 'work', repository: { url: repositoryUrl }, profile: 'project' });
  const first = createSession(request); const second = createSession(request);
  await store.create(first, { siteId, userId });
  await expect(store.create(second, { siteId, userId })).rejects.toThrow('conflict');
  await store.control(first.id, siteId, 'pause');
  await expect(store.create(second, { siteId, userId })).rejects.toThrow('conflict');
  await store.control(first.id, siteId, 'cancel');
  await expect(store.create(second, { siteId, userId })).resolves.toBeUndefined();
});