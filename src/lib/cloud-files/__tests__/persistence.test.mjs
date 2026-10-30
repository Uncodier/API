import assert from 'node:assert/strict';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('SQL serializes owner lifecycle and rechecks authorization after blocking mutation locks', () => {
  const sql=readFileSync(new URL('../../../../supabase/migrations/20261030010000_cloud_document_persistence.sql',import.meta.url),'utf8');
  assert.match(sql,/FROM public\.requirements WHERE id=p_requirement_id FOR SHARE/);
  assert.match(sql,/FROM public\.remote_instances WHERE id=p_instance_id FOR SHARE/);
  assert.match(sql,/cloud_requirement_binding_lock BEFORE INSERT OR UPDATE OF metadata,site_id OR DELETE/);
  assert.match(sql,/cloud_plan_binding_lock BEFORE INSERT OR UPDATE OF metadata,instance_id,site_id OR DELETE/);
  assert.match(sql,/ORDER BY i.id FOR UPDATE/);
  assert.match(sql,/pg_advisory_xact_lock\([^;]+;\s+PERFORM public\.cloud_file_check_scope/);
  for(const lock of ['SELECT * INTO f FROM public.cloud_files','SELECT * INTO g FROM public.cloud_file_git_results']) {
    let cursor=0,count=0;
    while((cursor=sql.indexOf(lock,cursor))!==-1) {
      const end=sql.indexOf('FOR UPDATE;',cursor);
      const remainder=sql.slice(end,end+650);
      assert.match(remainder,/PERFORM public\.cloud_file_check_scope/);
      cursor=end+11; count++;
    }
    assert.ok(count>0);
  }
  // PGlite uses one connection; separate-backend waiting transactions require
  // native PostgreSQL CI. Its real SQL tests below cover revocation at admission.
});

test('cloud persistence: real offline SQL authorization, atomic revisions and replay', async () => {
  const db = new PGlite();
  const site = randomUUID(), otherSite = randomUUID(), user = randomUUID(), denied = randomUUID();
  const instance = randomUUID(), sibling = randomUUID(), otherInstance = randomUUID();
  const requirement = randomUUID(), unrelated = randomUUID(), foreignReq = randomUUID();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE sites(id uuid PRIMARY KEY);
      CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,user_id uuid,is_archived boolean);
      CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,metadata jsonb);
      CREATE TABLE instance_plans(id uuid PRIMARY KEY,site_id uuid,instance_id uuid,metadata jsonb);
      CREATE TABLE access(site_id uuid,user_id uuid,effective boolean);
      CREATE FUNCTION site_user_has_effective_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS
        'SELECT effective FROM public.access WHERE site_id=$1 AND user_id=$2';`);
    await db.query('INSERT INTO sites VALUES ($1),($2)', [site, otherSite]);
    await db.query('INSERT INTO access VALUES ($1,$2,true)', [site,user]);
    for (const [id,tenant] of [[instance,site],[sibling,site],[otherInstance,otherSite]]) {
      await db.query('INSERT INTO remote_instances VALUES($1,$2,$3,false)',[id,tenant,user]);
    }
    for (const [id,tenant,owner] of [[requirement,site,sibling],[unrelated,site,sibling],[foreignReq,otherSite,instance]]) {
      await db.query('INSERT INTO requirements VALUES($1,$2,$3)',[id,tenant,{runner_instance_id:owner}]);
    }
    await db.exec(readFileSync(new URL('../../../../supabase/migrations/20261030010000_cloud_document_persistence.sql',import.meta.url),'utf8'));
    const rpc = async (operation,input={},scope={}) => (await db.query(
      'SELECT cloud_file_store($1,$2,$3,$4,$5,$6) result',
      [scope.site ?? site,scope.user ?? user,scope.instance ?? instance,scope.requirement ?? null,operation,input])).rows[0].result;
    const rejects = (promise,code) => assert.rejects(promise,e => e.code===code);
    await db.exec('SET ROLE service_role');
    const input={operation_id:randomUUID(),action:'create',name:'notes.md',mime:'text/markdown',content:'Hello 🌎'};
    const created=await rpc('write',input);
    assert.equal(created.state,'created'); assert.equal(created.version,1);
    assert.equal(created.bytes,Buffer.byteLength(input.content));
    assert.equal(created.sha256,createHash('sha256').update(input.content).digest('hex'));
    assert.equal(created.git_status,'pending'); assert.equal(created.requirement_id,null);
    assert.deepEqual(await rpc('write',input),created);
    assert.deepEqual(await rpc('operation',{operation_id:input.operation_id}),created);
    assert.equal(await rpc('operation',{operation_id:randomUUID()}),null);
    assert.equal(await rpc('operation',{operation_id:input.operation_id},{instance:sibling}),null);
    const collaborator=randomUUID();
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO access VALUES($1,$2,true),($3,$2,true)',[site,collaborator,otherSite]);
    await db.exec('SET ROLE service_role');
    assert.equal(await rpc('operation',{operation_id:input.operation_id},{user:collaborator}),null);
    assert.equal(await rpc('operation',{operation_id:input.operation_id},{user:collaborator,site:otherSite,instance:otherInstance}),null);
    await rejects(rpc('operation',{operation_id:input.operation_id,content:'injected'}),'CF001');
    await rejects(rpc('operation',{}),'CF001');
    await rejects(rpc('write',{...input,content:'different'}),'CF004');
    await rejects(rpc('write',input,{user:denied}),'CF002');
    await rejects(rpc('operation',{operation_id:input.operation_id},{user:denied}),'CF002');
    await rejects(rpc('read',{file_id:created.file_id},{instance:otherInstance}),'CF002');
    assert.equal(await rpc('read',{file_id:created.file_id},{instance:sibling}),null);
    assert.deepEqual((await rpc('list',{}, {instance:sibling})).files,[]);
    await rejects(rpc('list',{requirement_id:foreignReq}),'CF002');
    await rejects(rpc('list',{requirement_id:unrelated}),'CF002');
    await rejects(rpc('write',{...input,operation_id:randomUUID()},{requirement:unrelated}),'CF002');
    await rejects(rpc('list',{limit:0}),'CF001');
    await rejects(rpc('list',{query:'x',site_id:otherSite}),'CF001');
    const edit={operation_id:randomUUID(),action:'replace',file_id:created.file_id,expected_version:1,content:'Hello universe'};
    const updated=await rpc('write',edit); assert.equal(updated.version,2); assert.equal(updated.state,'updated');
    const conflict=await rpc('write',{...edit,operation_id:randomUUID(),content:'stale'});
    assert.equal(conflict.state,'conflict'); assert.equal(conflict.content,updated.content);
    assert.deepEqual(await rpc('write',edit),updated);
    assert.equal((await rpc('read',{file_id:created.file_id,version:1})).content,input.content);
    assert.equal((await rpc('read',{file_id:created.file_id})).content,edit.content);
    const noop=await rpc('write',{...edit,operation_id:randomUUID(),expected_version:2});
    assert.equal(noop.state,'unchanged'); assert.equal(noop.version,2);
    await rejects(rpc('write',{...edit,operation_id:randomUUID(),expected_version:undefined}),'CF001');
    const patched=await rpc('write',{operation_id:randomUUID(),action:'patch',file_id:created.file_id,expected_version:2,changes:[{old_text:'universe',new_text:'world'}]});
    assert.equal(patched.content,'Hello world'); assert.equal(patched.version,3);
    await rejects(rpc('write',{operation_id:randomUUID(),action:'patch',file_id:created.file_id,expected_version:3,changes:[{old_text:'Hello',new_text:'Greetings'},{old_text:'absent',new_text:'bad'}]}),'CF005');
    assert.equal((await rpc('read',{file_id:created.file_id})).content,'Hello world');
    const racing=await Promise.all(['first','second'].map(content => rpc('write',{
      ...edit,operation_id:randomUUID(),expected_version:3,content,
    })));
    assert.deepEqual(racing.map(file => file.state).sort(),['conflict','updated']);
    assert.equal((await rpc('read',{file_id:created.file_id})).version,4);
    const ambiguous=await rpc('write',{...input,operation_id:randomUUID(),content:'aaa'});
    await rejects(rpc('write',{operation_id:randomUUID(),action:'patch',file_id:ambiguous.file_id,expected_version:1,changes:[{old_text:'aa',new_text:'b'}]}),'CF005');
    for (const patch of [{content:'é'.repeat(131073)},{mime:'application/octet-stream'},{name:'../bad'},{name:'a\\b'},{name:'.Git'},{name:'.github'},{name:'CON.txt'},{name:'foo.'},{content:null}]) {
      await rejects(rpc('write',{...input,...patch,operation_id:randomUUID()}),'CF001');
    }
    const max=await rpc('write',{...input,operation_id:randomUUID(),content:'é'.repeat(131072)});
    assert.equal(max.bytes,262144);
    await db.exec('RESET ROLE');
    await db.query('UPDATE requirements SET metadata=$1 WHERE id=$2',[{runner_instance_id:instance},requirement]);
    await db.exec('SET ROLE service_role');
    await rejects(rpc('write',{...input,operation_id:randomUUID()}),'CF002');
    assert.deepEqual(await rpc('operation',{operation_id:input.operation_id}),created);
    const attached=await rpc('write',{...input,operation_id:randomUUID(),name:'task.md'},{requirement});
    assert.equal(attached.requirement_id,requirement);
    assert.equal(await rpc('operation',{operation_id:input.operation_id},{requirement}),null);
    assert.equal((await rpc('list',{requirement_id:requirement})).files.length,1);
    // A plan is a second valid ownership linkage; unrelated same-site IDs are not.
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO instance_plans VALUES($1,$2,$3,$4)',[randomUUID(),site,instance,{requirement_id:unrelated}]);
    await db.exec('SET ROLE service_role');
    assert.deepEqual((await rpc('list',{requirement_id:unrelated})).files,[]);
    // Plan-only bindings also fence standalone write admission.
    await db.exec('RESET ROLE');
    await db.query('UPDATE requirements SET metadata=$1 WHERE id=$2',[{runner_instance_id:sibling},requirement]);
    await db.exec('SET ROLE service_role');
    await rejects(rpc('write',{...input,operation_id:randomUUID()}),'CF002');
    await db.exec('RESET ROLE');
    await db.query('UPDATE requirements SET metadata=$1 WHERE id=$2',[{runner_instance_id:instance},requirement]);
    await db.exec('SET ROLE service_role');
    assert.equal(await rpc('read',{file_id:created.file_id},{requirement}),null);
    assert.equal((await rpc('list',{query:'task'})).files[0].file_id,attached.file_id);
    assert.equal((await rpc('list',{query:'🌎'})).files.length,1);
    assert.equal((await rpc('list',{limit:1})).next_offset,1);
    assert.equal((await rpc('list',{limit:1,offset:3})).next_offset,null);
    const sha=randomBytes(20).toString('hex');
    await rejects(rpc('git_result',{file_id:created.file_id,version:3,status:'committed',commitSha:sha}),'CF001');
    const target={file_id:created.file_id,version:3,repository:'offline/documents',ref:`refs/heads/cloud-files/${randomBytes(32).toString('hex')}/v3`,path:patched.name};
    const bound=await rpc('git_bind',target);
    assert.equal(bound.git_repository,target.repository); assert.equal(bound.git_ref,target.ref); assert.equal(bound.git_path,target.path);
    assert.deepEqual(await rpc('git_bind',target),bound);
    await rejects(rpc('git_bind',{...target,repository:'offline/other'}),'CF004');
    await rejects(rpc('git_bind',{...target,ref:target.ref.replace('/v3','/v4')}),'CF001');
    await rejects(rpc('git_bind',{...target,path:'other.txt'}),'CF001');
    const committed=await rpc('git_result',{file_id:created.file_id,version:3,status:'committed',commitSha:sha});
    assert.equal(committed.git_commit_sha,sha);
    const pending=(await rpc('git_pending')).files.filter(file => file.file_id===created.file_id);
    assert.deepEqual(pending.map(file => file.version),[1,2,4]);
    assert.deepEqual((await rpc('git_pending',{}, {instance:sibling})).files,[]);
    assert.equal((await rpc('git_result',{file_id:created.file_id,version:3,status:'failed'})).git_status,'committed');
    await rejects(rpc('git_result',{file_id:created.file_id,version:3,status:'committed',commitSha:randomBytes(20).toString('hex')}),'CF004');
    for (const table of ['cloud_files','cloud_file_revisions','cloud_file_git_results','cloud_file_operations']) {
      await rejects(db.query(`SELECT * FROM ${table}`),'42501');
      await rejects(db.query(`DELETE FROM ${table}`),'42501');
    }
    await db.exec('RESET ROLE');
    await rejects(db.query('UPDATE cloud_file_revisions SET content=content'),'CF001');
    await rejects(db.query('UPDATE cloud_file_operations SET state=state'),'CF001');
    for (const role of ['anon','authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await rejects(rpc('list'),'42501');
      await rejects(db.query('SELECT cloud_file_revision_json($1,1)',[created.file_id]),'42501');
      await rejects(db.query('SELECT * FROM cloud_files'),'42501');
      await db.exec('RESET ROLE');
    }
    await db.query('UPDATE access SET effective=false WHERE user_id=$1',[user]);
    await db.exec('SET ROLE service_role');
    await rejects(rpc('write',input),'CF002'); // Replays also reauthorize.
    await rejects(rpc('operation',{operation_id:input.operation_id}),'CF002');
    await db.exec('RESET ROLE');
    await db.query('UPDATE access SET effective=true WHERE user_id=$1',[user]);
    await db.query('UPDATE remote_instances SET is_archived=true WHERE id=$1',[instance]);
    await db.exec('SET ROLE service_role');
    await rejects(rpc('list'),'CF002');
  } finally { await db.close(); }
});

test('global Git recovery claims are bounded, leased, scoped, backed off and cascade on owner deletion', async () => {
  const db=new PGlite();
  const site=randomUUID(),user=randomUUID(),instance=randomUUID(),requirement=randomUUID();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE sites(id uuid PRIMARY KEY);
      CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,is_archived boolean);
      CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,metadata jsonb,status text);
      CREATE TABLE instance_plans(id uuid PRIMARY KEY,site_id uuid,instance_id uuid,metadata jsonb);
      CREATE TABLE access(site_id uuid,user_id uuid,effective boolean);
      CREATE FUNCTION site_user_has_effective_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS
        'SELECT effective FROM public.access WHERE site_id=$1 AND user_id=$2';`);
    await db.query('INSERT INTO sites VALUES($1)',[site]);
    await db.query('INSERT INTO remote_instances VALUES($1,$2,false)',[instance,site]);
    await db.query('INSERT INTO access VALUES($1,$2,true)',[site,user]);
    await db.query('INSERT INTO requirements VALUES($1,$2,$3,$4)',[requirement,site,{},'completed']);
    await db.exec(readFileSync(new URL('../../../../supabase/migrations/20261030010000_cloud_document_persistence.sql',import.meta.url),'utf8'));
    const rpc=async (operation,input,req=null) => (await db.query('SELECT cloud_file_store($1,$2,$3,$4,$5,$6) result',[site,user,instance,req,operation,input])).rows[0].result;
    const claim=async (limit=5) => (await db.query('SELECT * FROM claim_cloud_git_publications($1)',[limit])).rows;
    const admin=async fn => {await db.exec('RESET ROLE'); try {return await fn();} finally {await db.exec('SET ROLE service_role');}};
    const due=() => admin(() => db.exec("UPDATE cloud_file_git_results SET next_retry_at=clock_timestamp()-interval '1 second'"));
    await db.exec('SET ROLE service_role');
    const files=[];
    for(let i=1;i<7;i++) files[i]=await rpc('write',{operation_id:randomUUID(),action:'create',name:`doc${i}.txt`,content:'content'});
    await admin(()=>db.query('UPDATE requirements SET metadata=$1 WHERE id=$2',[{runner_instance_id:instance},requirement]));
    files[0]=await rpc('write',{operation_id:randomUUID(),action:'create',name:'doc0.txt',content:'content'},requirement);
    // Historical versions and completed requirements both remain recoverable.
    await rpc('write',{operation_id:randomUUID(),action:'replace',file_id:files[0].file_id,expected_version:1,content:'new'},requirement);
    const [first,second]=await Promise.all([claim(),claim()]);
    assert.equal(first.length,5); assert.equal(second.length,3);
    assert.equal(new Set([...first,...second].map(row => `${row.file_id}:${row.version}`)).size,8);
    assert.deepEqual(await claim(),[]);
    for(const row of [...first,...second]) {
      assert.equal(row.site_id,site); assert.equal(row.user_id,user); assert.equal(row.instance_id,instance);
      assert.equal(row.requirement_id,row.file_id===files[0].file_id?requirement:null);
    }
    for(const limit of [0,6,null]) await assert.rejects(claim(limit),e=>e.code==='CF001');
    const timing=await admin(async () => (await db.query('SELECT attempt_count,extract(epoch from next_retry_at-last_attempt_at) delay FROM cloud_file_git_results')).rows);
    assert.ok(timing.every(row=>row.attempt_count===1 && Math.abs(Number(row.delay)-300)<1));
    await rpc('git_result',{file_id:files[0].file_id,version:1,status:'failed'},requirement);
    assert.deepEqual(await claim(),[],'failure cannot shorten the claim visibility lease');
    await rpc('git_bind',{file_id:files[1].file_id,version:1,repository:'offline/documents',ref:`refs/heads/cloud-files/${randomBytes(32).toString('hex')}/v1`,path:files[1].name});
    await rpc('git_result',{file_id:files[1].file_id,version:1,status:'committed',commitSha:randomBytes(20).toString('hex')});
    await rpc('git_result',{file_id:files[2].file_id,version:1,status:'conflict'});
    await due();
    const retried=[...await claim(),...await claim()];
    assert.equal(retried.length,6);
    assert.ok(!retried.some(row=>[files[1].file_id,files[2].file_id].includes(row.file_id)));
    assert.ok(retried.some(row=>row.file_id===files[0].file_id && row.version===1));
    await admin(()=>db.exec('UPDATE cloud_file_git_results SET attempt_count=999999'));
    await due(); await claim(); await claim();
    const capped=await admin(async () => (await db.query("SELECT attempt_count,extract(epoch from next_retry_at-last_attempt_at) delay FROM cloud_file_git_results WHERE status IN ('pending','failed')")).rows);
    assert.ok(capped.every(row=>row.attempt_count===1000000 && Math.abs(Number(row.delay)-3600)<1));
    await due();
    await admin(()=>db.exec('UPDATE access SET effective=false'));
    assert.deepEqual(await claim(),[]);
    await admin(()=>db.exec('UPDATE access SET effective=true; UPDATE remote_instances SET is_archived=true'));
    assert.deepEqual(await claim(),[]);
    await admin(()=>db.exec('UPDATE remote_instances SET is_archived=false'));
    for(const role of ['anon','authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await assert.rejects(claim(),e=>e.code==='42501');
    }
    await db.exec('RESET ROLE');
    await db.query('DELETE FROM requirements WHERE id=$1',[requirement]);
    assert.equal((await db.query('SELECT count(*)::int n FROM cloud_files')).rows[0].n,6);
    await db.query('DELETE FROM remote_instances WHERE id=$1',[instance]);
    for(const table of ['cloud_files','cloud_file_revisions','cloud_file_git_results','cloud_file_operations']) {
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,`${table} content must cascade`);
    }
  } finally {await db.close();}
});