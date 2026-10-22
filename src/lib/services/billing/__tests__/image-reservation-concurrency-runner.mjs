import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { randomInt,randomUUID,createHash } from 'node:crypto';
import { existsSync,mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { imageBootstrap,imageMigration } from './image-reservation-bootstrap.mjs';
// Private temporary cluster/socket only; no inherited PG/environment credentials or TCP.
const bin=['/opt/homebrew/opt/postgresql@17/bin','/usr/lib/postgresql/17/bin','/usr/lib/postgresql/16/bin','/usr/lib/postgresql/15/bin'].find(p=>existsSync(join(p,'initdb')));
if(!bin)throw new Error('Image concurrency regression requires local PostgreSQL15+');
const temp=mkdtempSync('/tmp/image-reservation-pg-'),data=join(temp,'data'),port=String(randomInt(20000,60000));
const env={ PATH:`${bin}:/usr/bin:/bin`,LANG:'C',LC_ALL:'C',HOME:temp };
const args=['-X','-qAt','-h',temp,'-p',port,'-U','image_test_admin','-d','postgres','-v','ON_ERROR_STOP=1'];
const active=new Set();let started=false;
const command=(name,argv)=>{const r=spawnSync(join(bin,name),argv,{env,encoding:'utf8',timeout:30000});if(r.status!==0)throw new Error(r.stderr||r.stdout||String(r.error));};
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
const client=(sql,keep=false)=>{
  const name='image_'+randomUUID(),child=spawn(join(bin,'psql'),args,{env:{...env,PGAPPNAME:name},stdio:['pipe','pipe','pipe']});
  active.add(child);let output='',errors='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>errors+=v);
  const done=new Promise((res,rej)=>{child.on('error',rej);child.on('close',code=>{active.delete(child);code===0?res(output.trim()):rej(new Error(errors||output));});});done.catch(()=>{});
  const timer=setTimeout(()=>child.kill('SIGKILL'),20000);done.finally(()=>clearTimeout(timer)).catch(()=>{});
  child.stdin.on('error',()=>{});child.stdin.write("SET statement_timeout='10s';SET lock_timeout='5s';SET request.jwt.claim.role='service_role';\n"+sql+'\n');if(!keep)child.stdin.end();
  return {name,child,done,output:()=>output};
};
const sql=async text=>(await client(text).done).split('\n').filter(Boolean).at(-1);
const receipt=output=>JSON.parse(output.split('\n').find(line=>line.startsWith('{')));
const wait=async(fn,label)=>{const end=Date.now()+7000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Timeout '+label);};
const race=async(first,second)=>{
  const a=client(`BEGIN;${first}\n\\echo IMAGE_LOCK_HELD`,true);let b;
  try {
    await wait(()=>a.output().includes('IMAGE_LOCK_HELD'),'first lock');b=client(`BEGIN;${second}COMMIT;`);
    await wait(async()=>await sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${quote(b.name)} AND wait_event_type='Lock');`)==='t','contender real lock');
    a.child.stdin.end('COMMIT;\n');return await Promise.all([a.done,b.done]);
  }finally{if(!a.child.stdin.writableEnded)a.child.stdin.end('ROLLBACK;\n');await a.done.catch(()=>{});if(b)await b.done.catch(()=>{});}
};
const hash=()=>createHash('sha256').update(randomUUID()).digest('hex');
const site=randomUUID(),op=hash(),fingerprint=hash(),token=randomUUID();
const hold=(operation=op,claim=token,count=4)=>`SELECT hold_image_generation_credits(${quote(site)},${quote(operation)},${quote(fingerprint)},${quote(claim)},${count});`;
const dispatch=(claim=token)=>`SELECT dispatch_image_generation_reservation(${quote(site)},${quote(op)},${quote(claim)});`;
try {
  command('initdb',['-D',data,'-U','image_test_admin','--auth=trust','--no-locale','--encoding=UTF8']);
  command('pg_ctl',['-D',data,'-l',join(temp,'server.log'),'-o',`-k ${temp} -p ${port} -c listen_addresses=''`,'-w','start']);started=true;
  await sql(imageBootstrap);await sql(imageMigration);
  await sql(`INSERT INTO sites(id,name) VALUES(${quote(site)},'Synthetic concurrency');SELECT initialize_site_billing(${quote(site)});
    UPDATE billing SET plan_credits_available=0,purchased_credits_available=.4,plan_credit_anchor=now(),plan_credit_period_start=now(),plan_credit_period_end=now()+interval '1 day' WHERE site_id=${quote(site)};`);
  const competing=await race(hold(),hold(hash(),randomUUID(),1));
  assert.equal(receipt(competing[1]).code,'INSUFFICIENT_CREDITS',competing.join('\n'));
  assert.equal(await sql(`SELECT credits_available=0 AND credits_used=.4 FROM billing WHERE site_id=${quote(site)};`),'t');
  console.log('PASS real PostgreSQL distinct-operation concurrent overspend blocked');
  const same=await race(hold(),hold(op,randomUUID()));
  assert.equal(receipt(same[0]).created,false);assert.equal(receipt(same[1]).created,false);
  assert.equal(await sql(`SELECT count(*) FROM image_generation_credit_reservations WHERE site_id=${quote(site)};`),'1');
  const claims=await race(dispatch(),dispatch());
  assert.equal(receipt(claims[0]).success,true);assert.equal(receipt(claims[1]).success,false);
  console.log('PASS real PostgreSQL duplicate hold and dispatch single claimant');
  const final=`SELECT settle_image_generation_reservation(${quote(site)},${quote(op)},${quote(token)},1,NULL,NULL);`;
  await race(final,final);
  assert.equal(await sql(`SELECT purchased_credits_available=.3 AND credits_used=.1 FROM billing WHERE site_id=${quote(site)};`),'t');
  assert.equal(await sql(`SELECT count(*) FROM credit_transactions WHERE transaction_type='image_generation_release' AND site_id=${quote(site)};`),'1');
  assert.equal(await sql(`SELECT count(*) FROM credit_transactions WHERE transaction_type='image_generation_settlement' AND site_id=${quote(site)};`),'1');
  console.log('PASS real PostgreSQL concurrent settlement charges and restores original bucket once');
}finally{
  for(const child of active)child.kill('SIGKILL');
  if(started||existsSync(join(data,'postmaster.pid')))command('pg_ctl',['-D',data,'-w','-t','10','-m','immediate','stop']);
  rmSync(temp,{recursive:true,force:true});
}