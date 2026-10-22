import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
it('proves multi-session image hold/dispatch/settlement serialization on a private local PostgreSQL cluster',()=>{
  const run=spawnSync(process.execPath,[resolve(__dirname,'image-reservation-concurrency-runner.mjs')],{
    encoding:'utf8',timeout:100000,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test'},maxBuffer:2*1024*1024,
  });
  if(run.status!==0)throw new Error(run.stderr||run.stdout||String(run.error));
  expect(run.stdout.match(/PASS real PostgreSQL/g)).toHaveLength(3);
},110000);