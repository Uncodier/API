import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('real SQL accepts cloud without repo, preserves workspace checks and fences mode mutation', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE TABLE requirements (id uuid primary key, metadata jsonb);');
    await db.exec(await readFile(new URL('../../../../supabase/migrations/20261030020000_cloud_requirement_sessions.sql', import.meta.url), 'utf8'));
    const snapshot = { id: randomUUID(), version: 0, status: 'queued', request: {
      executionEnvironment: 'cloud', objective: 'Create a document', limits: { maxTurns: 10, maxOutputTokens: 1000, maxTotalTokens: 10000, maxActiveMs: 10000 },
    }, messages: [], uncertainOperations: [], turns: 0, allocatedTokens: 0, activeMs: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const valid = async s => (await db.query('SELECT public.valid_harness_snapshot($1::jsonb) AS valid', [s])).rows[0].valid;
    assert.equal(await valid(snapshot), true);
    assert.equal(await valid({ ...snapshot, request: { ...snapshot.request, repository: { url: 'https://example.test/repo' } } }), false);
    assert.equal(await valid({ ...snapshot, workspace: { provider: 'vercel', id: 'vm', root: '/vercel/sandbox' } }), false);
    assert.equal(await valid({ ...snapshot, request: { ...snapshot.request, executionEnvironment: 'other' } }), false);
    const legacy = structuredClone(snapshot); delete legacy.request.executionEnvironment;
    assert.equal(await valid(legacy), false);
    legacy.request.repository = { url: 'https://example.test/repo' };
    assert.equal(await valid(legacy), true);
    assert.equal(await valid({ ...snapshot, turns: -1 }), false);
    const id = randomUUID();
    await db.query('INSERT INTO requirements VALUES($1,$2)', [id, { execution_environment: 'cloud' }]);
    await assert.rejects(db.query('UPDATE requirements SET metadata=$2 WHERE id=$1', [id, {}]), /immutable/);
    await db.query('UPDATE requirements SET metadata=$2 WHERE id=$1', [id, { execution_environment: 'cloud', title: 'safe' }]);
    await assert.rejects(db.query('INSERT INTO requirements VALUES($1,$2)', [randomUUID(), { execution_environment: null }]), /invalid/);
  } finally { await db.close(); }
});