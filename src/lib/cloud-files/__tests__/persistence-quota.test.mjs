import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const sql = readFileSync(new URL('../../../../supabase/migrations/20261030010000_cloud_document_persistence.sql',import.meta.url),'utf8');
test('quota lock precedes scope, operation and file locks; migration stays bounded', () => {
  const body=sql.slice(sql.indexOf('CREATE FUNCTION public.cloud_file_store'));
  const quota=body.indexOf("pg_advisory_xact_lock(hashtextextended('cloud-quota:'");
  assert.ok(quota>=0 && quota<body.indexOf('PERFORM public.cloud_file_check_scope'));
  assert.ok(quota<body.indexOf('pg_advisory_xact_lock(hashtextextended(operation_id'));
  assert.ok(quota<body.indexOf('FOR UPDATE;'));
  assert.ok(sql.split('\n').length<500);
});

test('PGlite: pre-conflict validation, compact immutable receipts and aggregate quotas', async () => {
  const db=new PGlite(), site=randomUUID(), user=randomUUID(), instance=randomUUID();
  const rpc=async (operation,input={},owner=instance) => (await db.query(
    'SELECT cloud_file_store($1,$2,$3,NULL,$4,$5) result',[site,user,owner,operation,input])).rows[0].result;
  const write=input=>rpc('write',input);
  let transactional=false;
  const rejected=async (input,code='CF001')=>{
    if(transactional) await db.exec('SAVEPOINT expected_error');
    try {await assert.rejects(write(input),e=>e.code===code);}
    finally {if(transactional) await db.exec('ROLLBACK TO expected_error; RELEASE expected_error');}
  };
  const admin=async fn=>{await db.exec('RESET ROLE');const result=await fn();await db.exec('SET ROLE service_role');return result;};
  const stats=()=>admin(async ()=>(await db.query(`SELECT
    (SELECT count(*)::int FROM cloud_files) files,
    (SELECT count(*)::int FROM cloud_file_revisions) revisions,
    (SELECT count(*)::int FROM cloud_file_operations) ops,
    (SELECT coalesce(sum(octet_length(to_jsonb(o)::text)),0)::int FROM cloud_file_operations o) journal_bytes`)).rows[0]);
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE sites(id uuid PRIMARY KEY);
      CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,user_id uuid,is_archived boolean);
      CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,metadata jsonb);
      CREATE TABLE instance_plans(id uuid PRIMARY KEY,site_id uuid,instance_id uuid,metadata jsonb);
      CREATE FUNCTION site_user_has_effective_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';`);
    await db.query('INSERT INTO sites VALUES($1)',[site]);
    await db.query('INSERT INTO remote_instances VALUES($1,$2,$3,false)',[instance,site,user]);
    await db.exec(sql);
    await db.exec('SET ROLE service_role');
    const input={operation_id:randomUUID(),action:'create',name:'large.txt',content:'x'.repeat(262144)};
    const created=await write(input);
    const replace={operation_id:randomUUID(),action:'replace',file_id:created.file_id,expected_version:1,content:input.content};
    const receipts=[];
    for(let n=0;n<12;n++) {
      const args={...replace,operation_id:randomUUID()};
      receipts.push([args,await write(args)]);
    }
    const compact=await stats();
    assert.equal(compact.revisions,1); assert.equal(compact.ops,13);
    assert.ok(compact.journal_bytes<13000,'12 no-ops must not duplicate 6 MiB of arguments/results');
    await admin(async()=>{
      const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='cloud_file_operations'")).rows.map(r=>r.column_name);
      assert.ok(!columns.includes('arguments') && !columns.includes('result'));
      assert.equal((await db.query('SELECT min(octet_length(arguments_sha256)) n FROM cloud_file_operations')).rows[0].n,32);
    });
    assert.deepEqual(await write(Object.fromEntries(Object.entries(input).reverse())),created,'JSON key order is semantic, not lexical');
    await rejected({...input,mime:'text/plain'},'CF004'); // Omitted is not explicit default.
    const edit={...replace,operation_id:randomUUID(),content:'new'};
    const updated=await write(edit);
    const before=await stats();
    for(const invalid of [
      {content:'x'.repeat(1048576)}, {content:'🌎'.repeat(65537)},
      {name:''}, {name:'../bad'}, {name:'bad\\name'}, {name:'a'.repeat(201)}, {mime:'image/png'},
      {action:'patch',content:undefined,changes:[]},
      {action:'patch',content:undefined,changes:[{old_text:'x',new_text:'x'.repeat(262145)}]},
      {action:'patch',content:undefined,changes:[{old_text:'x'.repeat(262144),new_text:'x'.repeat(262144)},{old_text:'x',new_text:''}]},
      {action:'patch',content:undefined,changes:[{old_text:'x',new_text:null}]},
    ]) {
      const bad={...replace,...invalid,operation_id:randomUUID()};
      await rejected(bad);
      assert.equal(await rpc('operation',{operation_id:bad.operation_id}),null);
    }
    assert.deepEqual(await stats(),before,'invalid stale writes leave no receipt or revision');
    const conflictArgs={...replace,operation_id:randomUUID(),content:'stale'};
    const conflict=await write(conflictArgs);
    assert.equal(conflict.state,'conflict');
    await write({...edit,operation_id:randomUUID(),expected_version:2,content:'latest'});
    assert.deepEqual(await rpc('operation',{operation_id:conflictArgs.operation_id}),conflict);
    assert.deepEqual(await write(conflictArgs),conflict);
    assert.deepEqual(await rpc('operation',{operation_id:edit.operation_id}),updated);
    for(const [args,result] of receipts) assert.deepEqual(await write(args),result);
    await rpc('git_result',{file_id:created.file_id,version:1,status:'failed'});
    assert.deepEqual(await rpc('operation',{operation_id:input.operation_id}),{...created,git_status:'failed'});

    // Quota fixtures are generated entirely inside SQL, not huge RPC payloads.
    // All production constraints stay enabled, including byte/hash consistency.
    const fixture=async (kind,scope) => admin(async()=>{
      await db.exec('BEGIN; CREATE TEMP TABLE quota_owners(id uuid); CREATE TEMP TABLE quota_files(id uuid,instance_id uuid);');
      transactional=true;
      const owners=scope==='instance'?1:11;
      await db.query('INSERT INTO quota_owners SELECT CASE WHEN n=1 THEN $1::uuid ELSE gen_random_uuid() END FROM generate_series(1,$2) n',[instance,owners]);
      await db.query('INSERT INTO remote_instances SELECT id,$1,$2,false FROM quota_owners WHERE id<>$3',[site,user,instance]);
      const existing=await stats();
      await db.exec('RESET ROLE');
      const count=kind==='files'?(scope==='instance'?1000:10000)-existing.files:owners;
      await db.query(`INSERT INTO quota_files SELECT gen_random_uuid(),o.id FROM
        (SELECT id,row_number() OVER () n FROM quota_owners) o,
        generate_series(1,$1) s WHERE (s-1)%$2=o.n-1`,[count,owners]);
      await db.query(`INSERT INTO cloud_files(id,site_id,instance_id,current_version,created_by)
        SELECT id,$1,instance_id,1,$2 FROM quota_files`,[site,user]);
      if(kind==='bytes') {
        // Fill to just below the budget with compressible historical revisions,
        // then use bounded SQL-generated filler to land on the exact byte limit.
        await db.query(`INSERT INTO cloud_file_revisions(file_id,version,name,mime,content,sha256,bytes,created_by)
          SELECT id,n,'fixture.txt','text/plain',repeat('x',262144),
          encode(sha256(convert_to(repeat('x',262144),'UTF8')),'hex'),262144,$1
          FROM quota_files,generate_series(1,$2) n`,[user,scope==='instance'?125:92]);
        const used=Number((await db.query(`SELECT
          (SELECT sum(bytes::bigint+2048) FROM cloud_file_revisions)+
          (SELECT count(*)*256 FROM cloud_files)+(SELECT count(*)*256 FROM cloud_file_operations) n`)).rows[0].n);
        let remaining=(scope==='instance'?33554432:268435456)-used;
        let version=200;
        while(remaining>0) {
          const bytes=Math.min(262144,remaining-2048);
          assert.ok(bytes>=0);
          await db.query(`INSERT INTO cloud_file_revisions(file_id,version,name,mime,content,sha256,bytes,created_by)
            SELECT id,$1,'filler.txt','text/plain',repeat('x',$2),
            encode(sha256(convert_to(repeat('x',$2),'UTF8')),'hex'),$2,$3
            FROM quota_files ORDER BY id LIMIT 1`,[version++,bytes,user]);
          remaining-=bytes+2048;
        }
      } else {
        await db.query(`INSERT INTO cloud_file_revisions(file_id,version,name,mime,content,sha256,bytes,created_by)
          SELECT id,1,'fixture.txt','text/plain','',encode(sha256(''::bytea),'hex'),0,$1 FROM quota_files`,[user]);
      }
      if(kind==='ops') await db.query(`INSERT INTO cloud_file_operations(operation_id,file_id,arguments_sha256,site_id,user_id,instance_id,version,state)
        SELECT gen_random_uuid(),f.id,sha256(''::bytea),$1,$2,f.instance_id,1,'unchanged'
        FROM (SELECT *,row_number() OVER () n FROM quota_files) f,generate_series(1,$3) s
        WHERE (s-1)%$4=f.n-1`,[site,user,(scope==='instance'?10000:100000)-existing.ops,owners]);
    });
    for(const scope of ['instance','site']) for(const kind of ['bytes','files','ops']) {
      await fixture(kind,scope);
      try {
        await assert.doesNotReject(admin(()=>db.query('SELECT cloud_file_check_quota($1,$2)',[site,instance])),`${scope} ${kind}: fixture at quota, not above`);
        const prior=await stats();
        const attempt={operation_id:randomUUID(),action:'create',name:'denied.txt',content:'x'.repeat(262144)};
        await rejected(attempt,'CF006');
        assert.deepEqual(await stats(),prior,`${scope} ${kind}: quota rejection is atomic`);
        assert.deepEqual(await write(edit),updated,'replay works at quota');
        assert.deepEqual(await rpc('operation',{operation_id:edit.operation_id}),updated);
        if(kind==='ops' || kind==='bytes') {
          await rejected({...replace,operation_id:randomUUID()},'CF006'); // Conflict also consumes a receipt.
          await rejected({...replace,operation_id:randomUUID(),expected_version:3,content:'latest'},'CF006'); // No-op too.
        }
        await admin(()=>db.exec('DELETE FROM cloud_files WHERE id IN (SELECT id FROM quota_files)'));
        assert.equal((await write(attempt)).state,'created','deletion releases aggregate quota');
      } finally {await db.exec('ROLLBACK; SET ROLE service_role'); transactional=false;}
    }
  } finally {await db.close();}
});