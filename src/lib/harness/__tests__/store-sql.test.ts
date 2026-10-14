import { spawnSync } from 'node:child_process';

it('enforces migration ACL, tenant isolation, lease fencing, CAS, terminal integrity and bounds offline', () => {
  // The real migration runs only in ephemeral PGlite. Its single connection
  // checks competing requests/interleavings, not multi-connection lock races.
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { randomUUID } from 'node:crypto';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const site = randomUUID(), otherSite = randomUUID(), user = randomUUID();
    const initial = () => ({ id: randomUUID(), version: 0, status: 'queued', request: {
      objective: 'Offline task', repository: { url: 'https://example.test/repository' },
      limits: { maxTurns: 10, maxOutputTokens: 1024, maxTotalTokens: 100000, maxActiveMs: 30000 }
    }, messages: [], turns: 0, allocatedTokens: 0, activeMs: 0, uncertainOperations: [],
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    const insert = (s, tenant = site, actor = user) => db.query('INSERT INTO public.harness_sessions(id,site_id,user_id,snapshot,version) VALUES($1,$2,$3,$4,$5)',[s.id,tenant,actor,JSON.stringify(s),s.version]);
    const get = async id => (await db.query('SELECT * FROM public.harness_sessions WHERE id=$1',[id])).rows[0];
    const claim = async (id, owner, tenant = site, ttl = 180) => (await db.query('SELECT public.claim_harness_session($1,$2,$3,$4) AS result',[id,tenant,owner,ttl])).rows[0].result;
    const save = async (s, owner, tenant = site) => (await db.query('SELECT public.save_harness_session($1,$2,$3,$4) AS result',[s.id,tenant,owner,JSON.stringify(s)])).rows[0].result;
    const renew = async (id, owner, tenant = site, ttl = 180) => (await db.query('SELECT public.renew_harness_session($1,$2,$3,$4) AS result',[id,tenant,owner,ttl])).rows[0].result;
    const release = async (id, owner, tenant = site) => (await db.query('SELECT public.release_harness_session($1,$2,$3) AS result',[id,tenant,owner])).rows[0].result;
    const control = async (id, action, message = null, tenant = site) => (await db.query('SELECT public.control_harness_session($1,$2,$3,$4) AS result',[id,tenant,action,message])).rows[0].result;
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE public.sites(id uuid PRIMARY KEY);');
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;');
      await db.exec(readFileSync('supabase/migrations/20261014010000_portable_harness_sessions.sql','utf8'));
      await db.query('INSERT INTO public.sites VALUES($1),($2)',[site,otherSite]);
      await db.query('INSERT INTO auth.users VALUES($1)',[user]);
      assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.harness_sessions'::regclass")).rows[0].relrowsecurity,true);
      assert.equal((await db.query("SELECT count(*)::int n FROM pg_policies WHERE tablename='harness_sessions'")).rows[0].n,0);
      const functions = ['claim_harness_session(uuid,uuid,text,integer)','save_harness_session(uuid,uuid,text,jsonb)','renew_harness_session(uuid,uuid,text,integer)','release_harness_session(uuid,uuid,text)','control_harness_session(uuid,uuid,text,text)'];
      for (const role of ['anon','authenticated','service_role']) {
        for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
          const allowed=(await db.query('SELECT has_table_privilege($1,$2,$3) allowed',[role,'public.harness_sessions',privilege])).rows[0].allowed;
          assert.equal(allowed,role==='service_role' && ['SELECT','INSERT'].includes(privilege),role+':'+privilege);
        }
        for (const name of functions) {
          const allowed=(await db.query('SELECT has_function_privilege($1,$2,$3) allowed',[role,'public.'+name,'EXECUTE'])).rows[0].allowed;
          assert.equal(allowed,role==='service_role',role+':'+name);
        }
      }
      for (const role of ['anon','authenticated']) {
        await db.exec('SET ROLE '+role);
        await assert.rejects(()=>db.query('SELECT * FROM public.harness_sessions'),/permission denied/);
        await assert.rejects(()=>insert(initial()),/permission denied/);
        await assert.rejects(()=>claim(randomUUID(),'a'),/permission denied/);
        await db.exec('RESET ROLE');
      }
      await db.exec('SET ROLE service_role');
      const s = initial(); await insert(s);
      await assert.rejects(()=>insert(s),/unique constraint/);
      await assert.rejects(()=>insert(initial(),randomUUID()),/foreign key/);
      await assert.rejects(()=>insert(initial(),site,randomUUID()),/foreign key/);
      await assert.rejects(()=>db.query('UPDATE public.harness_sessions SET version=1 WHERE id=$1',[s.id]),/permission denied/);
      await assert.rejects(()=>db.query('DELETE FROM public.harness_sessions WHERE id=$1',[s.id]),/permission denied/);
      assert.equal(await claim(s.id,'a',otherSite),null);
      const attempts = await Promise.all(['a','b','c'].map(owner=>claim(s.id,owner)));
      assert.equal(attempts.filter(Boolean).length,1);
      let owned = attempts[0]; assert.equal(owned.version,1); assert.equal(owned.status,'running');
      assert.equal(await save(owned,'a',otherSite),null);
      assert.equal(await renew(s.id,'a',otherSite),false);
      assert.equal(await release(s.id,'a',otherSite),false);
      assert.equal(await control(s.id,'cancel',null,otherSite),null);
      assert.equal(await renew(s.id,'b'),false);
      assert.equal(await save(owned,'b'),null);
      const sameOwner = await claim(s.id,'a'); assert.equal(sameOwner.version,2);
      assert.equal(await save(owned,'a'),null); owned = sameOwner;
      assert.equal(await renew(s.id,'a'),true);
      assert.equal((await get(s.id)).snapshot.version,owned.version);
      const workspace = { provider: 'vercel', id: 'offline-sandbox', root: '/workspace' };
      const pending = { call: { id: 'operation-1', name: 'publish', arguments: '{}' }, fingerprint: 'uncertain-1', effect: 'write' };
      owned = await save({...owned,turns:2,allocatedTokens:5000,activeMs:30,workspace,pending,uncertainOperations:['uncertain-1']},'a');
      for (const mutation of [
        { request:{...owned.request,objective:'Changed'} }, { workspace:{...workspace,id:'other'} },
        { createdAt:'replacement' }, { turns:1 }, { allocatedTokens:0 }, { activeMs:0 }, { uncertainOperations:[] }
      ]) await assert.rejects(()=>save({...owned,...mutation},'a'),/immutable|Invalid harness snapshot update/);
      await assert.rejects(()=>save({...owned,workspace:null},'a'),/Invalid harness snapshot/);
      // Only the test superuser advances lease expiry; no live clocks or sleep.
      await db.exec('RESET ROLE');
      await db.query("UPDATE public.harness_sessions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[s.id]);
      await db.exec('SET ROLE service_role');
      assert.equal(await renew(s.id,'a'),false); assert.equal(await save(owned,'a'),null);
      let replacement = await claim(s.id,'b'); assert.equal(replacement.version,owned.version+1);
      assert.equal(await release(s.id,'a'),false); assert.equal(await save(owned,'a'),null);
      assert.equal(await renew(s.id,'b'),true);
      const paused = await control(s.id,'pause'); assert.equal(paused.status,'paused');
      assert.equal(await save(replacement,'b'),null); assert.equal(await renew(s.id,'b'),false);
      const resumed = await control(s.id,'resume','Continue after inspection');
      assert.equal(resumed.status,'queued'); assert.deepEqual(resumed.pending,pending);
      assert.deepEqual(resumed.uncertainOperations,['uncertain-1']); assert.equal(resumed.turns,2); assert.equal(resumed.allocatedTokens,5000); assert.equal(resumed.activeMs,30);
      assert.deepEqual(resumed.messages.at(-1),{role:'user',content:'Continue after inspection'});
      replacement = await claim(s.id,'c');
      const done = await save({...replacement,status:'completed'},'c');
      assert.equal(await renew(s.id,'c'),false);
      assert.equal(await release(s.id,'c'),true);
      assert.deepEqual((await get(s.id)).snapshot,done);
      assert.equal((await get(s.id)).lease_owner,null);
      for (const action of ['pause','cancel','resume']) assert.equal(await control(s.id,action),null);
      assert.equal(await claim(s.id,'d'),null);
      const canceled = initial(); await insert(canceled); const old = await claim(canceled.id,'a');
      const canceledSnapshot = await control(canceled.id,'cancel'); assert.equal(canceledSnapshot.status,'cancelled');
      assert.equal(await save(old,'a'),null); assert.equal(await claim(canceled.id,'b'),null); assert.equal(await control(canceled.id,'resume'),null);
      for (const status of ['waiting','failed']) {
        const waiting = initial(); await insert(waiting); const claim1 = await claim(waiting.id,'worker');
        await save({...claim1,status},'worker');
        assert.equal(await control(waiting.id,'resume'),null);
        assert.equal(await release(waiting.id,'worker'),true);
        assert.equal((await control(waiting.id,'resume')).status,'queued');
      }
      const interrupted=initial(); await insert(interrupted);
      assert.equal((await control(interrupted.id,'resume')).status,'queued');
      const active=await claim(interrupted.id,'a');
      await save({...active,pending},'a');
      assert.equal(await control(interrupted.id,'resume'),null);
      await db.exec('RESET ROLE');
      await db.query("UPDATE public.harness_sessions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[interrupted.id]);
      await db.exec('SET ROLE service_role');
      const recovered=await control(interrupted.id,'resume');
      assert.equal(recovered.status,'queued'); assert.deepEqual(recovered.pending,pending);
      assert.equal(await save(active,'a'),null);
      for (const ttl of [0,-1,301,null]) await assert.rejects(()=>claim(s.id,'a',site,ttl),/Invalid harness lease/);
      await assert.rejects(()=>claim(s.id,'',site,180),/Invalid harness lease/);
      await assert.rejects(()=>control(s.id,'resume','x'.repeat(20001)),/Invalid harness control/);
      await assert.rejects(()=>control(s.id,'unknown'),/Invalid harness control/);
      for (const mutation of [ {status:'running'}, {version:1}, {messages:{}}, {request:{}}, {turns:-1}, {uncertainOperations:[1]}, {pending:{}}, {workspace:{}}, {activeMs:1} ]) {
        await assert.rejects(()=>insert({...initial(),...mutation}),/Invalid|check constraint/);
      }
      const badLimits = initial(); badLimits.request.limits.maxTurns=1001; await assert.rejects(()=>insert(badLimits),/Invalid/);
      const nullLimits = initial(); nullLimits.request.limits.maxTotalTokens=null; await assert.rejects(()=>insert(nullLimits),/Invalid/);
      const oversized = initial(); oversized.messages=[{role:'user',content:'x'.repeat(4000001)}]; await assert.rejects(()=>insert(oversized),/Invalid/);
      const profiled = initial(); profiled.request.profile='shared-resource'; await insert(profiled);
      const duplicateProfile = initial(); duplicateProfile.request.profile='shared-resource';
      await assert.rejects(()=>insert(duplicateProfile),/unique|duplicate/);
      await control(profiled.id,'cancel');
      await insert(duplicateProfile);
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Offline harness SQL test failed');
  expect(child.stdout.trim()).toBe('passed');
}, 50_000);