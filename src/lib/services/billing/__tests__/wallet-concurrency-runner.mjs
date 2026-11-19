import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { walletReservationSchema } from './wallet-reservation-bootstrap.mjs';

// Like image-reservation-concurrency-runner: actual independent PostgreSQL
// sessions, a private temporary Unix socket, no TCP/config/env/credentials.
const bin = [
  '/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin',
].find(path => ['initdb', 'pg_ctl', 'psql'].every(name => existsSync(join(path, name))));
if (!bin) throw new Error('Wallet concurrency regression requires local PostgreSQL 15+ (not skipped)');
const payoutFixture = readFileSync(new URL('./wallet-payout-fixture.sql', import.meta.url), 'utf8');
const temp = mkdtempSync('/tmp/wallet-concurrency-pg-');
const data = join(temp, 'data'), port = String(randomInt(20000, 60000));
const env = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C', HOME: temp };
const args = ['-X', '-qAt', '-h', temp, '-p', port, '-U', 'wallet_test_admin',
  '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const active = new Set();
let started = false, cleaned = false, checks = 0, lockWaits = 0;
const command = (name, argv) => {
  const result = spawnSync(join(bin, name), argv, { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout || result.error}`);
};
const cleanup = () => {
  if (cleaned) return;
  for (const child of active) child.kill('SIGKILL');
  if (started || existsSync(join(data, 'postmaster.pid'))) {
    command('pg_ctl', ['-D', data, '-w', '-t', '10', '-m', 'immediate', 'stop']);
  }
  rmSync(temp, { recursive: true, force: true });
  cleaned = true;
};
const interrupted = () => { cleanup(); process.exit(1); };
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
process.once('exit', cleanup);
const watchdog = setTimeout(() => {
  console.error('Wallet concurrency runner exceeded its local execution deadline');
  interrupted();
}, 100000);
const quote = value => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
const client = (text, { keep = false, role = null } = {}) => {
  assert.ok(role === null || ['service_role', 'anon', 'authenticated'].includes(role));
  const name = `wallet_${randomUUID()}`;
  const child = spawn(join(bin, 'psql'), args, {
    env: { ...env, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  active.add(child);
  let output = '', errors = '', finished = false;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.on('error', error => { errors += String(error); });
  // Expected payout/legacy debit failures are returned, not swallowed or mocked.
  const done = new Promise(resolve => child.on('close', code => {
    finished = true;
    active.delete(child);
    resolve({ code, output: output.trim(), errors });
  }));
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  done.then(() => clearTimeout(timer));
  child.stdin.on('error', () => {});
  child.stdin.write(`SET statement_timeout='20s'; SET lock_timeout='12s';
    SET idle_in_transaction_session_timeout='20s'; SET request.jwt.claim.role='service_role';
    ${role ? `SET ROLE ${role};` : ''}\n${text}\n`);
  if (!keep) child.stdin.end();
  return { name, child, done, output: () => output, finished: () => finished };
};
const success = result => {
  assert.equal(result.code, 0, result.errors || result.output);
  return result.output.split('\n').filter(line => line && line !== 'WALLET_LOCK_HELD').at(-1);
};
const failure = (result, pattern) => {
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.errors, pattern);
};
const sql = async text => success(await client(text).done);
const service = async text => await client(text, { role: 'service_role' }).done;
const receipt = result => {
  success(result);
  const line = result.output.split('\n').find(value => value.startsWith('{'));
  assert.ok(line, result.output);
  return JSON.parse(line);
};
const wait = async (predicate, label) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timeout proving ${label}`);
};
const race = async (label, first, second) => {
  const a = client(`BEGIN; ${first}\n\\echo WALLET_LOCK_HELD`, { keep: true, role: 'service_role' });
  let b;
  try {
    await wait(() => {
      assert.equal(a.finished(), false, a.output());
      return a.output().includes('WALLET_LOCK_HELD');
    }, `${label}: first transaction`);
    b = client(`BEGIN; ${second}\nCOMMIT;`, { role: 'service_role' });
    // A successful sequential run or a guessed sleep is NOT concurrency proof.
    // Require a live lock wait blocked specifically by our uncommitted writer.
    await wait(async () => {
      if (b.finished()) throw new Error(`${label}: contender did not wait: ${JSON.stringify(await b.done)}`);
      return await sql(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity contender JOIN pg_stat_activity holder
          ON holder.pid = ANY(pg_blocking_pids(contender.pid))
        WHERE contender.application_name=${quote(b.name)} AND contender.wait_event_type='Lock'
          AND holder.application_name=${quote(a.name)} AND holder.state='idle in transaction'
      );`) === 't';
    }, `${label}: wait_event_type=Lock + pg_blocking_pids`);
    assert.equal(b.finished(), false);
    lockWaits++;
    console.log(`LOCK ${label}: wait_event_type=Lock, blocked by first transaction`);
    a.child.stdin.end('COMMIT;\n');
    const results = await Promise.all([a.done, b.done]);
    success(results[0]);
    return results;
  } finally {
    if (!a.child.stdin.writableEnded) a.child.stdin.end('ROLLBACK;\n');
    await a.done;
    if (b) await b.done;
  }
};
const check = async (name, run) => {
  await run();
  checks++;
  console.log(`PASS real PostgreSQL ${name}`);
};
const call = (name, values) => `SELECT public.${name}(${values.map(quote).join(',')});`;
const payout = (site, amount = '.4') => call('deduct_balance', [site, amount]);
const debit = (site, amount = '.4', event = randomUUID()) => call('deduct_credits',
  [site, amount, 'wallet_concurrency_debit', 'Synthetic concurrent debit', JSON.stringify({ event })]);
const legacyDebit = (site, amount = '.4') => call('deduct_credits', [site, amount]);
const seed = async ({ purchased = '0', wallet = '.4' } = {}) => {
  const site = randomUUID();
  await sql(`INSERT INTO public.sites(id,name) VALUES(${quote(site)},'Synthetic wallet concurrency');
    SELECT public.initialize_site_billing(${quote(site)});
    UPDATE public.billing SET plan_credits_available=0,legacy_credits_available=0,
      purchased_credits_available=${quote(purchased)}::numeric,account_balance=${quote(wallet)}::numeric,
      plan_credit_allowance=1,credits_used=0,monthly_credits_used=0,plan_credits_used=0,
      plan_credit_anchor=now(),plan_credit_period_start=now(),plan_credit_period_end=now()+interval '1 day'
    WHERE site_id=${quote(site)};`);
  return site;
};
const state = async (site, { wallet, purchased = '0', used = '0' }) => {
  assert.equal(await sql(`SELECT account_balance=${wallet} AND purchased_credits_available=${purchased}
    AND credits_available=${purchased} AND credits_used=${used} AND monthly_credits_used=${used}
    AND plan_credits_used=0 AND plan_credits_available=0 AND legacy_credits_available=0 AND trial_credits_available=0
    AND credits_available=trial_credits_available+plan_credits_available+legacy_credits_available+purchased_credits_available
    FROM public.billing WHERE site_id=${quote(site)};`), 't', JSON.stringify({ site, wallet, purchased, used }));
};
const ledger = async (site, expected) => {
  const normalized = expected.map(entry => ({ ...entry, restored: entry.restored ?? null }))
    .sort((a, b) => a.type.localeCompare(b.type));
  // Compare NUMERIC/JSONB inside PostgreSQL, not rounded JavaScript doubles.
  const result = JSON.parse(await sql(`WITH actual AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'type',transaction_type,'amount',amount,'wallet',metadata->'account_balance_spent',
      'restored',metadata->'account_balance_restored') ORDER BY transaction_type),'[]'::jsonb) value
    FROM public.credit_transactions WHERE site_id=${quote(site)}
  ) SELECT jsonb_build_object('matches',value=${quote(JSON.stringify(normalized))}::jsonb,'actual',value) FROM actual;`));
  assert.equal(result.matches, true, JSON.stringify({ actual: result.actual, expected: normalized }));
};
const snapshot = async site => JSON.parse(await sql(`SELECT jsonb_build_object(
  'billing',(SELECT to_jsonb(b) FROM public.billing b WHERE site_id=${quote(site)}),
  'ledger',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.credit_transactions t WHERE site_id=${quote(site)}),
  'image',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY operation_id),'[]') FROM public.image_generation_credit_reservations r WHERE site_id=${quote(site)}),
  'model',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY event_id),'[]') FROM public.harness_model_credit_reservations r WHERE site_id=${quote(site)})
);`));

const image = {
  name: 'image', table: 'image_generation_credit_reservations', key: 'operation_id', released: 'released',
  operation: async site => ({ site, id: hash(), fingerprint: hash(), token: randomUUID() }),
  hold: r => call('hold_image_generation_credits', [r.site, r.id, r.fingerprint, r.token, 4]),
  dispatch: r => call('dispatch_image_generation_reservation', [r.site, r.id, r.token]),
  settle: r => call('settle_image_generation_reservation', [r.site, r.id, r.token, 1, null, null]),
  release: r => call('release_image_generation_reservation', [r.site, r.id, r.token, 'not_dispatched']),
  holdType: 'image_generation_hold', refundType: 'image_generation_release', settlementType: 'image_generation_settlement',
};
const model = {
  name: 'model', table: 'harness_model_credit_reservations', key: 'event_id', released: 'cancelled',
  operation: async site => {
    const session = randomUUID();
    await sql(`INSERT INTO public.harness_sessions(id,site_id,lease_owner,lease_expires_at,snapshot)
      VALUES(${quote(session)},${quote(site)},'owner',now()+interval '1 hour','{"status":"running"}');`);
    return { site, id: randomUUID(), session };
  },
  hold: r => call('reserve_harness_model_credits', [r.session, r.site, 'owner', r.id, '.4']),
  dispatch: r => call('dispatch_harness_model_reservation', [r.session, r.id]),
  settle: r => call('settle_harness_model_reservation', [r.session, r.id, '.08', null, null]),
  release: r => call('cancel_harness_model_reservation', [r.session, r.id, 'predispatch']),
  holdType: 'agent_model_reservation', refundType: 'agent_model_refund', settlementType: 'agent_model_settlement',
};
const heldLedger = (driver, wallet = .4) => [{ type: driver.holdType, amount: -.4, wallet }];
const finalLedger = (driver, wallet, release = false) => [
  ...heldLedger(driver, wallet),
  { type: driver.refundType, amount: release ? .4 : .3, wallet, restored: release ? wallet : Math.min(wallet, .3) },
  { type: driver.settlementType, amount: 0, wallet, restored: release ? wallet : Math.min(wallet, .3) },
];
const reservation = async (driver, r, { count = 1, wallet = '.4', charged = null, status = 'reserved' } = {}) => {
  assert.equal(await sql(`SELECT count(*) FROM public.${driver.table} WHERE site_id=${quote(r.site)};`), String(count));
  if (!count) return;
  assert.equal(await sql(`SELECT state=${quote(status)} AND amount=.4 AND account_balance_spent=${wallet}
    AND amount=trial_spent+plan_spent+legacy_spent+purchased_spent+account_balance_spent
    ${charged === null ? '' : `AND charged=${charged}`}
    FROM public.${driver.table} WHERE ${driver.key}=${quote(r.id)};`), 't');
};
const insufficient = result => {
  const value = receipt(result);
  assert.equal(value.success, false);
  assert.match(value.error || value.code, /Insufficient credits|INSUFFICIENT_CREDITS/);
  return value;
};
const payoutInsufficient = /Billing record not found or insufficient balance/;
const legacyInsufficient = /Insufficient total usable credits/;

try {
  command('initdb', ['-D', data, '-U', 'wallet_test_admin', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  command('pg_ctl', ['-D', data, '-l', join(temp, 'server.log'), '-o',
    `-k ${temp} -p ${port} -c listen_addresses='' -c unix_socket_permissions=0700`, '-w', 'start']);
  started = true;
  // Includes actual imageBootstrap/imageMigration, current shared model fixture,
  // then the core forward migration followed by the reservation forward migration.
  await sql(walletReservationSchema);
  await sql(payoutFixture);
  await check('private socket-only cluster and real service role', async () => {
    assert.equal(await sql(`SELECT current_setting('listen_addresses')='' AND inet_server_addr() IS NULL
      AND current_setting('unix_socket_directories')=${quote(temp)};`), 't');
    assert.equal(success(await service('SELECT current_user;')), 'service_role');
  });

  await check('classified debit wins before payout and preserves remaining/metadata semantics', async () => {
    const site = await seed({ purchased: '.1' });
    const results = await race('debit before payout', debit(site), payout(site));
    assert.deepEqual(receipt(results[0]), { success: true, remaining: 0, account_balance: .1, total_available: .1 });
    failure(results[1], payoutInsufficient);
    await state(site, { wallet: '.1', used: '.4' });
    await ledger(site, [{ type: 'wallet_concurrency_debit', amount: -.4, wallet: .3 }]);
  });
  await check('payout wins before classified debit without any partial charge', async () => {
    const site = await seed({ purchased: '.1' });
    const results = await race('payout before debit', payout(site), debit(site));
    assert.equal(Number(success(results[0])), 0);
    assert.equal(insufficient(results[1]).available, .1);
    await state(site, { wallet: '0', purchased: '.1' });
    await ledger(site, []);
  });
  await check('legacy debit wins before payout without double wallet debit', async () => {
    const site = await seed({ purchased: '.1' });
    const results = await race('legacy debit before payout', legacyDebit(site), payout(site));
    assert.equal(Number(success(results[0])), 0);
    failure(results[1], payoutInsufficient);
    await state(site, { wallet: '.1', used: '.4' });
    await ledger(site, [{ type: 'credit_usage', amount: -.4, wallet: .3 }]);
  });
  await check('payout wins before legacy debit with atomic failure', async () => {
    const site = await seed({ purchased: '.1' });
    const results = await race('payout before legacy debit', payout(site), legacyDebit(site));
    assert.equal(Number(success(results[0])), 0);
    failure(results[1], legacyInsufficient);
    await state(site, { wallet: '0', purchased: '.1' });
    await ledger(site, []);
  });
  await check('distinct classified direct debits have one winner and no overspend', async () => {
    const site = await seed({ wallet: '.7', purchased: '.2' }), event = randomUUID();
    const results = await race('distinct direct debits', debit(site, '.6', event), debit(site, '.6'));
    assert.deepEqual(receipt(results[0]), { success: true, remaining: 0, account_balance: .3, total_available: .3 });
    assert.equal(insufficient(results[1]).available, .3);
    await state(site, { wallet: '.3', used: '.6' });
    await ledger(site, [{ type: 'wallet_concurrency_debit', amount: -.6, wallet: .4 }]);
    assert.equal(await sql(`SELECT metadata->>'event' FROM public.credit_transactions WHERE site_id=${quote(site)};`), event);
  });
  await check('distinct legacy direct debits have one winner and one ledger entry', async () => {
    const site = await seed();
    const results = await race('distinct legacy debits', legacyDebit(site), legacyDebit(site));
    assert.equal(Number(success(results[0])), 0);
    failure(results[1], legacyInsufficient);
    await state(site, { wallet: '0', used: '.4' });
    await ledger(site, [{ type: 'credit_usage', amount: -.4, wallet: .4 }]);
  });

  for (const driver of [image, model]) {
    await check(`${driver.name} hold wins before payout with exact wallet provenance`, async () => {
      const r = await driver.operation(await seed({ purchased: '.1' }));
      const results = await race(`${driver.name} hold before payout`, driver.hold(r), payout(r.site));
      assert.equal(receipt(results[0]).success, true);
      failure(results[1], payoutInsufficient);
      await state(r.site, { wallet: '.1', used: '.4' });
      await reservation(driver, r, { wallet: '.3' });
      await ledger(r.site, heldLedger(driver, .3));
    });
    await check(`payout wins before ${driver.name} hold without creating a receipt`, async () => {
      const r = await driver.operation(await seed({ purchased: '.1' }));
      const results = await race(`payout before ${driver.name} hold`, payout(r.site), driver.hold(r));
      assert.equal(Number(success(results[0])), 0);
      assert.equal(insufficient(results[1]).available, .1);
      await state(r.site, { wallet: '0', purchased: '.1' });
      await reservation(driver, r, { count: 0 });
      await ledger(r.site, []);
    });
    await check(`distinct ${driver.name} holds serialize on one wallet with one winner`, async () => {
      const r = await driver.operation(await seed()), other = await driver.operation(r.site);
      const results = await race(`distinct ${driver.name} holds`, driver.hold(r), driver.hold(other));
      assert.equal(receipt(results[0]).success, true);
      assert.equal(insufficient(results[1]).available, 0);
      await state(r.site, { wallet: '0', used: '.4' });
      await reservation(driver, r);
      await ledger(r.site, heldLedger(driver));
    });
    await check(`concurrent duplicate ${driver.name} hold and settlement debit/refund once`, async () => {
      const r = await driver.operation(await seed());
      const results = await race(`duplicate ${driver.name} hold`, driver.hold(r), driver.hold(r));
      results.forEach(result => assert.equal(receipt(result).success, true));
      if (driver === image) {
        assert.equal(receipt(results[0]).created, true);
        assert.equal(receipt(results[1]).created, false);
      }
      await state(r.site, { wallet: '0', used: '.4' });
      await reservation(driver, r);
      await ledger(r.site, heldLedger(driver));
      assert.equal(receipt(await service(driver.dispatch(r))).success, true);
      const settled = await race(`duplicate ${driver.name} settlement`, driver.settle(r), driver.settle(r));
      settled.forEach(result => assert.deepEqual(receipt(result), { success: true, state: 'settled', charged: .1 }));
      await state(r.site, { wallet: '.3', used: '.1' });
      await reservation(driver, r, { status: 'settled', charged: '.1' });
      await ledger(r.site, finalLedger(driver, .4));
      const before = await snapshot(r.site);
      assert.equal(receipt(await service(driver.hold(r))).success, true);
      assert.deepEqual(await snapshot(r.site), before);
      if (driver === model) {
        assert.equal(await sql(`SELECT count(*)=1 AND bool_and(state='charged' AND provider_cost=.08 AND amount=.1)
          FROM public.openrouter_generation_charges WHERE site_id=${quote(r.site)};`), 't');
      }
    });
    await check(`concurrent duplicate ${driver.name} release restores only once`, async () => {
      const r = await driver.operation(await seed());
      assert.equal(receipt(await service(driver.hold(r))).success, true);
      const results = await race(`duplicate ${driver.name} release`, driver.release(r), driver.release(r));
      results.forEach(result => assert.deepEqual(receipt(result), { success: true, state: driver.released, charged: 0 }));
      await state(r.site, { wallet: '.4' });
      await reservation(driver, r, { status: driver.released, charged: '0' });
      await ledger(r.site, finalLedger(driver, .4, true));
    });
    for (const release of [false, true]) {
      for (const payoutFirst of [false, true]) {
        const action = release ? 'release' : 'settlement';
        const label = `${driver.name} ${payoutFirst ? `payout before ${action}` : `${action} before payout`}`;
        await check(`${label} conserves wallet, buckets, counters and ledger`, async () => {
          // There is enough unheld wallet for payout in either order. This makes
          // the payout actually wait even before an uncommitted refund is visible.
          const r = await driver.operation(await seed({ wallet: '.6', purchased: '.1' }));
          assert.equal(receipt(await service(driver.hold(r))).success, true);
          if (!release) assert.equal(receipt(await service(driver.dispatch(r))).success, true);
          const finish = release ? driver.release(r) : driver.settle(r), pay = payout(r.site, '.3');
          const results = await race(label, payoutFirst ? pay : finish, payoutFirst ? finish : pay);
          assert.equal(Number(success(results[payoutFirst ? 0 : 1])), payoutFirst ? 0 : .3);
          assert.deepEqual(receipt(results[payoutFirst ? 1 : 0]), {
            success: true, state: release ? driver.released : 'settled', charged: release ? 0 : .1,
          });
          await state(r.site, { wallet: '.3', purchased: release ? '.1' : '0', used: release ? '0' : '.1' });
          await reservation(driver, r, { wallet: '.3', status: release ? driver.released : 'settled', charged: release ? '0' : '.1' });
          await ledger(r.site, finalLedger(driver, .3, release));
          const before = await snapshot(r.site);
          assert.equal(receipt(await service(finish)).success, true);
          assert.deepEqual(await snapshot(r.site), before);
        });
      }
    }
    await check(`${driver.name} negative wallet offsets admission and survives original-bucket release`, async () => {
      const denied = await driver.operation(await seed({ purchased: '.4', wallet: '-.01' }));
      const before = await snapshot(denied.site);
      assert.equal(insufficient(await service(driver.hold(denied))).available, .39);
      await reservation(driver, denied, { count: 0 });
      assert.deepEqual(await snapshot(denied.site), before);
      const allowed = await driver.operation(await seed({ purchased: '.5', wallet: '-.1' }));
      assert.equal(receipt(await service(driver.hold(allowed))).success, true);
      await state(allowed.site, { wallet: '-.1', purchased: '.1', used: '.4' });
      await reservation(driver, allowed, { wallet: '0' });
      assert.equal(receipt(await service(driver.release(allowed))).success, true);
      await state(allowed.site, { wallet: '-.1', purchased: '.5' });
      await ledger(allowed.site, finalLedger(driver, 0, true));
    });
  }

  await check('negative wallet offsets both direct debit signatures without clearing debt', async () => {
    const site = await seed({ purchased: '.4', wallet: '-.01' }), before = await snapshot(site);
    assert.equal(insufficient(await service(debit(site))).available, .39);
    failure(await service(legacyDebit(site)), legacyInsufficient);
    assert.deepEqual(await snapshot(site), before);
    assert.deepEqual(receipt(await service(debit(site, '.39'))), {
      success: true, remaining: .01, account_balance: -.01, total_available: 0,
    });
    await state(site, { wallet: '-.01', purchased: '.01', used: '.39' });
    await ledger(site, [{ type: 'wallet_concurrency_debit', amount: -.39, wallet: 0 }]);
  });
  await check('real database grants deny browsers and keep private mutation helpers inaccessible', async () => {
    const site = await seed({ wallet: '1' }), i = await image.operation(site), m = await model.operation(site);
    const before = await snapshot(site);
    const publicCalls = [debit(site), legacyDebit(site), payout(site),
      ...[image.hold(i), image.dispatch(i), image.settle(i), image.release(i)],
      ...[model.hold(m), model.dispatch(m), model.settle(m), model.release(m)]];
    const privateCalls = [
      call('hold_harness_model_credits', [m.session, site, m.id, '.4', null]),
      call('finish_harness_model_reservation', [m.session, m.id, null, null, null, 'predispatch']),
      call('finish_image_generation_reservation', [site, i.id, i.token, null, 'not_dispatched', null, null]),
      'SELECT * FROM public.harness_model_credit_reservations;',
      'UPDATE public.image_generation_credit_reservations SET account_balance_spent=0;',
    ];
    // Even a spoofed service_role JWT GUC in client() cannot bypass SQL ACLs.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const text of [...(role === 'service_role' ? [] : publicCalls), ...privateCalls]) {
        failure(await client(text, { role }).done, /permission denied/);
      }
    }
    assert.deepEqual(await snapshot(site), before);
  });
  assert.equal(checks, 29);
  assert.equal(lockWaits, 26);
  console.log(`passed ${checks} wallet concurrency checks; proved ${lockWaits} actual lock waits`);
} finally {
  clearTimeout(watchdog);
  cleanup();
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  process.removeListener('exit', cleanup);
  assert.equal(existsSync(temp), false, 'Temporary PostgreSQL cluster must be removed');
  console.log('CLEANUP private PostgreSQL cluster stopped and removed');
}