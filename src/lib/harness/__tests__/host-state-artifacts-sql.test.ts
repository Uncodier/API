import { spawnSync } from 'node:child_process';

it('runs real host/artifact migrations with private ACL, scoped FK, encryption, owner/CAS fencing and reserved quota in PGlite', () => {
  // One ephemeral connection validates SQL and interleavings, not multi-connection lock scheduling.
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const site=randomUUID(), otherSite=randomUUID(), user=randomUUID(), owner=randomUUID();
    const initial = () => ({ id:randomUUID(), version:0, status:'queued', request:{objective:'Offline storage test',repository:{url:'https://repo.example.invalid/project'},
      limits:{maxTurns:10,maxOutputTokens:1024,maxTotalTokens:100000,maxActiveMs:30000}}, messages:[],turns:0,allocatedTokens:0,activeMs:0,uncertainOperations:[],
      createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString() });
    const rpc = async (name,args) => (await db.query('SELECT public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS result',args)).rows[0].result;
    const insert = s => db.query('INSERT INTO public.harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[s.id,site,user,JSON.stringify(s)]);
    const claim = (s,worker=owner) => rpc('claim_harness_session',[s.id,site,worker,180]);
    const load = (s,tenant=site,worker=owner) => rpc('load_harness_host_state',[s.id,tenant,worker]);
    const save = (s,version,ciphertext,tenant=site,worker=owner) => rpc('save_harness_host_state',[s.id,tenant,worker,version,ciphertext]);
    const reserve = (s,op,bytes,tenant=site,worker=owner) => rpc('reserve_harness_artifact',[s.id,tenant,worker,op,bytes]);
    const hash = (s,op,text) => createHash('sha256').update(s.id).update('\0').update(op).update('\0').update(text).digest('hex');
    const put = (s,op,text,tenant=site,worker=owner,id=hash(s,op,text)) => rpc('put_harness_artifact',[s.id,tenant,worker,op,id,text]);
    const read = (s,id,tenant=site,worker=owner) => rpc('read_harness_artifact',[s.id,tenant,worker,id]);
    const domain='portable-harness/host-state/aes-256-gcm/v1';
    const key=createHash('sha256').update(domain).update('\0key\0').update(randomBytes(32).toString('hex')).digest();
    const seal = (s,config,version,tenant=site) => {
      const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
      cipher.setAAD(Buffer.from(JSON.stringify([domain,s.id,tenant,version])));
      const encrypted=Buffer.concat([cipher.update(JSON.stringify(config),'utf8'),cipher.final()]);
      return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join('.');
    };
    const unseal = (s,row,tenant=site) => {
      const [,iv,tag,body]=row.ciphertext.split('.');
      const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));
      cipher.setAAD(Buffer.from(JSON.stringify([domain,s.id,tenant,row.version])));cipher.setAuthTag(Buffer.from(tag,'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(body,'base64')),cipher.final()]).toString('utf8'));
    };
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE public.sites(id uuid PRIMARY KEY);');
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;');
      for (const file of ['20261014010000_portable_harness_sessions.sql','20261014020000_portable_harness_host_state.sql']) {
        await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
      }
      await db.query('INSERT INTO public.sites VALUES($1),($2)',[site,otherSite]);await db.query('INSERT INTO auth.users VALUES($1)',[user]);
      const tables=['harness_host_state','harness_artifacts','harness_artifact_reservations'];
      const signatures=['load_harness_host_state(uuid,uuid,text)','save_harness_host_state(uuid,uuid,text,bigint,text)',
        'reserve_harness_artifact(uuid,uuid,text,text,integer)','put_harness_artifact(uuid,uuid,text,text,text,text)','read_harness_artifact(uuid,uuid,text,text)'];
      for (const table of tables) {
        assert.equal((await db.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',['public.'+table])).rows[0].relrowsecurity,true);
        assert.equal((await db.query('SELECT count(*)::int n FROM pg_policies WHERE tablename=$1',[table])).rows[0].n,0);
        for (const role of ['anon','authenticated','service_role']) for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
          assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) allowed',[role,'public.'+table,privilege])).rows[0].allowed,false);
        }
        const publicGrant=await db.query("SELECT count(*)::int n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=$1::regclass AND a.grantee=0",['public.'+table]);
        assert.equal(publicGrant.rows[0].n,0);
      }
      for (const fn of signatures) {
        for (const role of ['anon','authenticated','service_role']) assert.equal((await db.query('SELECT has_function_privilege($1,$2,$3) allowed',[role,'public.'+fn,'EXECUTE'])).rows[0].allowed,role==='service_role');
        const props=(await db.query('SELECT prosecdef,proconfig,proacl FROM pg_proc WHERE oid=$1::regprocedure',['public.'+fn])).rows[0];
        assert.equal(props.prosecdef,true);assert.deepEqual(props.proconfig,['search_path=pg_catalog']);
        assert.equal((await db.query('SELECT count(*)::int n FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure AND a.grantee=0',['public.'+fn])).rows[0].n,0);
      }
      for (const role of ['anon','authenticated','service_role']) assert.equal((await db.query('SELECT has_function_privilege($1,$2,$3) allowed',[role,'public.lock_harness_host_owner(uuid,uuid,text)','EXECUTE'])).rows[0].allowed,false);
      const s=initial(), second=initial();
      await db.exec('SET ROLE service_role');await insert(s);await insert(second);
      await assert.rejects(()=>load(s),/ownership conflict/);
      await claim(s);await claim(second);
      assert.equal(await load(s),null);
      const oldValue=randomBytes(32).toString('hex'), newValue=randomBytes(32).toString('hex');
      const config={layers:{tenant:{values:{ACCESS_TOKEN:oldValue}}},redactionValues:[oldValue]};
      const encrypted=seal(s,config,1);
      assert.equal(await save(s,0,encrypted),1);
      assert.deepEqual(unseal(s,await load(s)),config);
      await assert.rejects(()=>save(s,0,encrypted),/version conflict/);
      const rotated={layers:{tenant:{values:{ACCESS_TOKEN:newValue}}},redactionValues:[oldValue,newValue]};
      assert.equal(await save(s,1,seal(s,rotated,2)),2);
      const stored=await load(s);assert.deepEqual(unseal(s,stored),rotated);
      assert.throws(()=>unseal(second,stored));assert.throws(()=>unseal(s,stored,otherSite));
      await assert.rejects(()=>save(s,2,JSON.stringify(config)),/Invalid harness encrypted state/);
      await assert.rejects(()=>save(s,2,'v1.'+randomBytes(12).toString('base64')+'.'+randomBytes(16).toString('base64')+'.'+'x'.repeat(262144)),/Invalid harness encrypted state/);
      await db.exec('RESET ROLE');
      const hostRepresentation=JSON.stringify((await db.query('SELECT * FROM public.harness_host_state')).rows);
      const snapshots=JSON.stringify((await db.query('SELECT snapshot FROM public.harness_sessions')).rows);
      for (const value of [oldValue,newValue]) { assert.equal(hostRepresentation.includes(value),false);assert.equal(snapshots.includes(value),false); }
      // Composite FKs reject cross-site links even for the privileged migration owner.
      await assert.rejects(()=>db.query('INSERT INTO public.harness_host_state VALUES($1,$2,$3,$4)',[second.id,otherSite,1,seal(second,config,1)]),/foreign key/);
      await assert.rejects(()=>db.query('INSERT INTO public.harness_artifacts(session_id,site_id,id,operation_id,content) VALUES($1,$2,$3,$4,$5)',[second.id,otherSite,hash(second,'op','text'),'op','text']),/foreign key/);
      await assert.rejects(()=>db.query('INSERT INTO public.harness_artifact_reservations VALUES($1,$2,$3,$4)',[second.id,otherSite,'op',1]),/foreign key/);
      await db.exec('SET ROLE service_role');
      for (const table of tables) await assert.rejects(()=>db.query('SELECT * FROM public.'+table),/permission denied/);
      const op=randomUUID(), text='REDACTED '+ '😀α'.repeat(20000)+' TAIL_COMPLETE';
      assert.equal(await reserve(s,op,1048576),true);assert.equal(await reserve(s,op,1048576),true);
      const artifact=await put(s,op,text);
      assert.deepEqual(artifact,{id:hash(s,op,text),bytes:Buffer.byteLength(text),chars:text.length});
      assert.deepEqual(await put(s,op,text),artifact);assert.deepEqual(await read(s,artifact.id),{text});
      assert.equal((await read(s,artifact.id)).text.slice(60000).includes('TAIL_COMPLETE'),true);
      assert.equal(await read(second,artifact.id),null);
      await assert.rejects(()=>put(s,op,text,site,owner,'0'.repeat(64)),/identity/);
      await assert.rejects(()=>put(s,op,'x'.repeat(1048577)),/quota/);
      for (const [tenant,worker] of [[otherSite,owner],[site,'stale']]) {
        for (const fn of [()=>load(s,tenant,worker),()=>save(s,2,seal(s,rotated,3),tenant,worker),()=>reserve(s,op,1,tenant,worker),()=>put(s,op,text,tenant,worker),()=>read(s,artifact.id,tenant,worker)]) await assert.rejects(fn,/ownership conflict/);
      }
      // Check clock_timestamp at use time: an old transaction timestamp must not revive a lease.
      await db.exec('RESET ROLE');await db.query("UPDATE public.harness_sessions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[s.id]);await db.exec('SET ROLE service_role');
      for (const fn of [()=>load(s),()=>save(s,2,seal(s,rotated,3)),()=>reserve(s,op,1),()=>put(s,op,text),()=>read(s,artifact.id)]) await assert.rejects(fn,/ownership conflict/);
      const nextOwner=randomUUID();await claim(s,nextOwner);
      assert.deepEqual(unseal(s,await load(s,site,nextOwner)),rotated);assert.equal((await read(s,artifact.id,site,nextOwner)).text,text);
      const active=(await db.query('SELECT snapshot FROM public.harness_sessions WHERE id=$1',[s.id])).rows[0].snapshot;
      await rpc('save_harness_session',[s.id,site,nextOwner,JSON.stringify({...active,status:'waiting'})]);
      await assert.rejects(()=>load(s,site,nextOwner),/ownership conflict/);await assert.rejects(()=>read(s,artifact.id,site,nextOwner),/ownership conflict/);
      // Reserve the full quota BEFORE execution, check idempotency and no overcommit.
      const full=initial();await insert(full);await claim(full);
      for(let i=0;i<16;i++) assert.equal(await reserve(full,'op-'+i,1048576),true);
      assert.equal(await reserve(full,'op-0',1048576),true);
      await assert.rejects(()=>reserve(full,'overflow',1),/quota/);
      await assert.rejects(()=>put(full,'unreserved','x'),/quota/);
      const small=await put(full,'op-0','small');
      assert.equal(await reserve(full,'reclaimed',1048571),true);
      await assert.rejects(()=>reserve(full,'overflow',1),/quota/);
      for(let i=1;i<16;i++) await put(full,'op-'+i,'x'.repeat(1048576));
      await put(full,'reclaimed','x'.repeat(1048571));
      assert.deepEqual(await put(full,'op-0','small'),small);
      await assert.rejects(()=>reserve(full,'overflow',1),/quota/);
      await assert.rejects(()=>reserve(full,'op-0',1),/quota/); // consumed is not free capacity
      await assert.rejects(()=>put(full,'overflow','x'),/quota/);
      assert.deepEqual(await read(full,small.id),{text:'small'});
      await db.exec('RESET ROLE');
      assert.equal((await db.query('SELECT sum(bytes)::int n FROM public.harness_artifacts WHERE session_id=$1',[full.id])).rows[0].n,16777216);
      assert.equal((await db.query('SELECT sum(bytes)::int n FROM public.harness_artifact_reservations WHERE session_id=$1',[full.id])).rows[0].n,0);
      for(const role of ['anon','authenticated']) {
        await db.exec('SET ROLE '+role);
        await assert.rejects(()=>load(full),/permission denied/);await assert.rejects(()=>read(full,small.id),/permission denied/);await assert.rejects(()=>reserve(full,'op',1),/permission denied/);
        await db.exec('RESET ROLE');
      }
      await db.query('DELETE FROM public.harness_sessions WHERE id=$1',[full.id]);
      for (const table of tables) assert.equal((await db.query('SELECT count(*)::int n FROM public.'+table+' WHERE session_id=$1',[full.id])).rows[0].n,0);
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  // Synthetic secrets never enter diagnostics: report only process outcome on failure.
  if (child.status !== 0) throw new Error(`Offline host/artifact SQL test failed (exit ${child.status ?? 'timeout'}); ${child.stderr.replace(/[a-f0-9]{32,}/gi, '[REDACTED]').slice(-6000)}`);
  expect(child.stdout.trim()).toBe('passed');
}, 65_000);