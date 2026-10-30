import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Import the actual TypeScript store offline; its default client is an inert stub.
// No environment, network, credentials or Next build is required.
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const typesUrl = moduleUrl(transpile(readFileSync(new URL('../types.ts',import.meta.url),'utf8')));
const source = readFileSync(new URL('../store.ts',import.meta.url),'utf8')
  .replace("import { supabaseAdmin } from '@/lib/database/supabase-client';", 'const supabaseAdmin = { rpc() { throw new Error("Offline default client"); } };')
  .replaceAll("'./types'",JSON.stringify(typesUrl));
const { createCloudFileStore, CloudFileStoreError } = await import(moduleUrl(transpile(source)));
const scope = () => ({siteId:randomUUID(),userId:randomUUID(),instanceId:randomUUID()});

test('store forwards trusted scope and exact write/list/read/git arguments to RPC',async () => {
  const calls=[]; const value={file_id:randomUUID(),version:1};
  const store=createCloudFileStore({rpc:async (...args) => { calls.push(args); return {data:value,error:null}; }});
  const s={...scope(),requirementId:randomUUID()};
  const input={operation_id:randomUUID(),action:'create',name:'a.txt',content:'hello'};
  assert.equal(await store.write(s,input),value);
  assert.deepEqual(calls[0],['cloud_file_store',{
    p_site_id:s.siteId,p_user_id:s.userId,p_instance_id:s.instanceId,p_requirement_id:s.requirementId,
    p_operation:'write',p_input:input,
  }]);
  await store.read(s,value.file_id,3);
  assert.deepEqual(calls.at(-1)[1].p_input,{file_id:value.file_id,version:3});
  await store.read(s,value.file_id);
  assert.deepEqual(calls.at(-1)[1].p_input,{file_id:value.file_id});
  await store.list(s,{requirement_id:s.requirementId,offset:10,limit:2,query:'a'});
  assert.equal(calls.at(-1)[1].p_input.offset,10);
  const sha=randomBytes(20).toString('hex');
  await store.setGitResult(s,value.file_id,3,{status:'committed',commitSha:sha});
  assert.deepEqual(calls.at(-1)[1].p_input,{file_id:value.file_id,version:3,status:'committed',commitSha:sha});
  await store.list(scope());
  assert.equal(calls.at(-1)[1].p_requirement_id,null);
  await store.listPendingGit(s,{limit:5});
  assert.equal(calls.at(-1)[1].p_operation,'git_pending');
  assert.deepEqual(calls.at(-1)[1].p_input,{limit:5});
  const target={repository:'offline/documents',ref:'refs/heads/cloud-files/unused/v3',path:'a.txt'};
  await store.bindGitTarget(s,value.file_id,3,target);
  assert.equal(calls.at(-1)[1].p_operation,'git_bind');
  assert.deepEqual(calls.at(-1)[1].p_input,{file_id:value.file_id,version:3,...target});
  await store.readOperation(s,input.operation_id);
  assert.equal(calls.at(-1)[1].p_operation,'operation');
  assert.deepEqual(calls.at(-1)[1].p_input,{operation_id:input.operation_id});
});

test('store fails closed on malformed trusted scope and emits only fixed safe errors',async () => {
  let calls=0;
  const store=createCloudFileStore({rpc:async () => { calls++; return {data:null,error:null}; }});
  for (const s of [null,{}, {...scope(),userId:''}, {...scope(),requirementId:'bad'}]) {
    await assert.rejects(store.list(s),error => error instanceof CloudFileStoreError && error.code==='invalid_input');
  }
  assert.equal(calls,0);
  const sensitive=randomBytes(32).toString('hex');
  for (const [code,expected] of [['CF001','invalid_input'],['CF002','forbidden'],['CF003','not_found'],['CF004','operation_mismatch'],['CF005','patch_conflict'],['CF006','quota_exceeded'],['42P01','unavailable']]) {
    const faulty=createCloudFileStore({rpc:async () => ({data:null,error:{code,message:sensitive,details:sensitive}})});
    await assert.rejects(faulty.list(scope()),error => {
      assert.equal(error.code,expected); assert.ok(!String(error).includes(sensitive));
      assert.ok(!JSON.stringify(error).includes(sensitive)); return true;
    });
  }
  const throwing=createCloudFileStore({rpc:async () => {throw new Error(sensitive);}});
  await assert.rejects(throwing.list(scope()),error => error.code==='unavailable' && !String(error).includes(sensitive));
});