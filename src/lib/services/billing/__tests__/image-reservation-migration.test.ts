import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
it('executes exact image reservation SQL with real offline PostgreSQL semantics', () => {
  const run=spawnSync(process.execPath,[resolve(__dirname,'image-reservation-postgres-runner.mjs')],{
    encoding:'utf8',timeout:90000,env:{ PATH:process.env.PATH, HOME:process.env.HOME, NODE_ENV:'test' },maxBuffer:2*1024*1024,
  });
  if(run.status!==0)throw new Error(run.stderr||run.stdout||String(run.error));
  expect(run.stdout).toContain('passed 10 image SQL checks');
},100000);