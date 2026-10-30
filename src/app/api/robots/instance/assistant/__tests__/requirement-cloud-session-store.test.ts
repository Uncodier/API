import { randomUUID } from 'node:crypto';
import { createSession, sessionRequestSchema } from '@/lib/harness/session';
import { MemorySessionStore } from '@/lib/harness/memory-store';

test('root session schema admits cloud without a repository and retains legacy workspace requirements', () => {
  const cloud = createSession({ objective: 'Draft a document', executionEnvironment: 'cloud' });
  expect(cloud.request).toMatchObject({ executionEnvironment: 'cloud', objective: 'Draft a document' });
  expect(cloud.request.repository).toBeUndefined();
  expect(cloud.workspace).toBeUndefined();
  expect(sessionRequestSchema.safeParse({ objective: 'Legacy' }).success).toBe(false);
  const repository = { url: 'https://repository.example.test/documents' };
  expect(sessionRequestSchema.safeParse({ objective: 'Legacy', repository }).success).toBe(true);
  expect(sessionRequestSchema.safeParse({ objective: 'Workspace', repository, executionEnvironment: 'workspace' }).success).toBe(true);
  expect(sessionRequestSchema.safeParse({ objective: 'Cloud', repository, executionEnvironment: 'cloud' }).success).toBe(false);
  for (const executionEnvironment of [null, '', 'invalid', 1]) {
    expect(sessionRequestSchema.safeParse({ objective: 'Invalid mode', repository, executionEnvironment }).success).toBe(false);
  }
});

test('cloud memory snapshots support scoped create/claim/save/release/resume without workspace state', async () => {
  const store = new MemorySessionStore();
  const session = createSession({ objective: 'Draft a document', executionEnvironment: 'cloud' });
  session.request.requirementId = randomUUID();
  const scope = { siteId: randomUUID(), userId: randomUUID() };
  const owner = randomUUID();
  await store.create(session, scope);
  expect(await store.load(session.id, randomUUID())).toBeNull();
  const claimed = (await store.claim(session.id, scope.siteId, owner, 300))!;
  expect(claimed.status).toBe('running');
  await store.save({ ...claimed, status: 'waiting', turns: 1,
    messages: [...claimed.messages, { role: 'assistant', content: 'Draft saved' }] }, scope.siteId, owner);
  await store.release(session.id, scope.siteId, owner);
  await store.control(session.id, scope.siteId, 'resume');
  const continued = await store.claim(session.id, scope.siteId, randomUUID(), 300);
  expect(continued).toMatchObject({ id: session.id, turns: 1, request: session.request });
  expect(continued?.messages.at(-1)?.content).toBe('Draft saved');
  expect(continued?.workspace).toBeUndefined();
});

test.each(['repository', 'workspace', 'environment', 'requirement'])('memory save rejects cloud %s rebinding without mutating the persisted request', async field => {
  const store = new MemorySessionStore();
  const session = createSession({ objective: 'Draft', executionEnvironment: 'cloud' });
  session.request.requirementId = randomUUID();
  const scope = { siteId: randomUUID(), userId: randomUUID() };
  const owner = randomUUID();
  await store.create(session, scope);
  const claimed = (await store.claim(session.id, scope.siteId, owner, 300))!;
  const changed = structuredClone(claimed);
  if (field === 'repository') changed.request.repository = { url: 'https://repository.example.test/documents' };
  if (field === 'workspace') changed.workspace = { provider: 'vercel', id: randomUUID(), root: '/workspace' };
  if (field === 'environment') {
    changed.request.executionEnvironment = 'workspace';
    changed.request.repository = { url: 'https://repository.example.test/documents' };
  }
  if (field === 'requirement') changed.request.requirementId = randomUUID();
  await expect(store.save(changed, scope.siteId, owner)).rejects.toMatchObject({ code: 'invalid' });
  expect(await store.load(session.id, scope.siteId)).toEqual(claimed);
});