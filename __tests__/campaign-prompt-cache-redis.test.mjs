import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

// Opt in with CAMPAIGN_TEST_REDIS_SERVER=/absolute/path/to/redis-server (>=6.2),
// then run node --test on this file. Takes ~60s: no fake clocks or shortened TTL.
const binary = process.env.CAMPAIGN_TEST_REDIS_SERVER;
const key = site => `cache:active-campaign-prompt:v1:${site.toLowerCase()}`;
const mustHit = async () => assert.fail('cache hit called the loader');
const evalCalls = async redis => Number((await redis.info('commandstats')).match(/^cmdstat_eval:calls=(\d+)/m)?.[1] ?? 0);

async function startPrivateRedis(t) {
  assert.ok(isAbsolute(binary), 'CAMPAIGN_TEST_REDIS_SERVER must be an absolute executable path');
  // Short Unix socket path (including on macOS); mkdtemp creates a private directory.
  const dir = await mkdtemp('/tmp/campaign-prompt-');
  const socket = join(dir, 'redis.sock');
  const server = spawn(binary, ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700',
    '--dir', dir, '--save', '', '--appendonly', 'no'], { cwd: dir, env: {}, stdio: 'ignore' });
  const closed = new Promise(resolve => server.once('close', resolve));
  let redis;
  t.after(async () => {
    redis?.disconnect();
    server.kill();
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
  await once(server, 'spawn');

  // The production URL parser forwards ioredis's `path` option. No TCP listener,
  // .env loading, caller-supplied endpoint, credentials or default Redis port.
  const url = new URL('redis://127.0.0.1:1');
  url.searchParams.set('path', socket);
  for (const name of ['REDIS_CACHE_URL', 'REDIS_URL']) {
    const before = process.env[name];
    process.env[name] = url.href;
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
  }
  const unregister = register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });
  t.after(unregister);
  const { getRedisClient, waitForRedis } = await import('@/lib/utils/redis-client');
  redis = getRedisClient();
  assert.equal(redis.options.path, socket);
  assert.ok(await waitForRedis(5000), 'fixture Redis did not become ready');
  const info = await redis.info('server');
  assert.match(info, new RegExp(`^process_id:${server.pid}\\r?$`, 'm'));
  assert.match(info, /^tcp_port:0\r?$/m);
  const version = info.match(/^redis_version:([^\r\n]+)/m)?.[1];
  const [major, minor] = (version ?? '').split('.').map(Number);
  assert.ok(major > 6 || (major === 6 && minor >= 2), `need Redis >=6.2 for SET PXAT; got ${version}`);
  assert.equal(await redis.dbsize(), 0, 'expected a new empty Redis');
  t.diagnostic(`Redis ${version}, PID ${server.pid}, private Unix socket, TCP disabled`);
  return redis;
}

test('production campaign prompt cache on disposable Redis', {
  skip: binary ? false : 'set CAMPAIGN_TEST_REDIS_SERVER to a local redis-server >=6.2', timeout: 90_000,
}, async t => {
  const redis = await startPrivateRedis(t);
  const { getCampaignPromptProjection: read, invalidateCampaignPromptProjection: invalidate } =
    await import('@/lib/services/campaign-prompt-cache');

  await t.test('invalidation fences an in-flight miss without evicting another site', async () => {
    const site = randomUUID(), other = randomUUID();
    const old = [{ title: 'Old' }], fresh = [{ title: 'Fresh' }], isolated = [{ title: 'Other site' }];
    await read(other, async () => isolated);
    const started = Promise.withResolvers(), finish = Promise.withResolvers();
    const stale = read(site, () => { started.resolve(); return finish.promise; });
    let marker;
    const before = await evalCalls(redis);
    try {
      await Promise.race([started.promise, stale]); // GET has completed; the loader still holds old data.
      assert.equal(await redis.get(key(site)), null);
      await invalidate(site.toUpperCase());
      marker = await redis.get(key(site));
      assert.ok(marker, 'invalidation must replace the miss with a marker');
      const ttl = await redis.pttl(key(site));
      assert.ok(ttl > 0 && ttl <= 60_000, `marker PTTL ${ttl}ms`);
    } finally {
      finish.resolve(old);
    }
    assert.deepEqual(await stale, old, 'the original caller may see its own snapshot');
    assert.equal(await evalCalls(redis), before + 1, 'stale fill must reach Redis Lua');
    assert.equal(await redis.get(key(site)), marker, 'stale fill overwrote the marker');
    assert.deepEqual(await read(site, async () => fresh), fresh);
    assert.equal(await redis.get(key(site)), JSON.stringify(fresh));
    assert.deepEqual(await read(site.toUpperCase(), mustHit), fresh);
    assert.deepEqual(await read(other, mustHit), isolated);
  });

  await t.test('Lua fills on miss; a canonical hit skips loading; the real 60s deadline expires', async t => {
    const site = randomUUID(), rows = [{ title: 'Campaign', description: 'Offer' }];
    const before = await evalCalls(redis);
    const start = Date.now();
    // Distinguish the production PXAT read deadline from a new 60s TTL at fill time.
    assert.deepEqual(await read(site, async () => { await delay(250); return rows; }), rows);
    assert.equal(await evalCalls(redis), before + 1, 'fill must execute EVAL on the server');
    assert.equal(await redis.get(key(site)), JSON.stringify(rows));
    const ttl = await redis.pttl(key(site));
    assert.ok(ttl > 0 && ttl >= 60_000 - (Date.now() - start) - 2 && ttl <= 59_800, `fill PTTL ${ttl}ms`);
    t.diagnostic(`PTTL after delayed load: ${ttl}ms`);
    assert.deepEqual(await read(site.toUpperCase(), mustHit), rows);

    await delay(ttl + 25);
    assert.equal(await redis.pttl(key(site)), -2, 'key must expire without help from the test');
    const replacement = [{ title: 'After expiry' }];
    assert.deepEqual(await read(site, async () => replacement), replacement);
    assert.deepEqual(await read(site, mustHit), replacement);
  });
});