import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const bin = '/opt/homebrew/opt/postgresql@17/bin';
const migration = 'supabase/migrations/20261114210000_requirement_economic_recovery_contention.sql';
const nativeTest = existsSync(`${bin}/initdb`) ? it : it.skip;

nativeTest('native PG skips busy recovery dependencies and revisits without blocking ordinary claims', async () => {
  // Unix socket only, disposable local cluster, no environment/remote database.
  const root = mkdtempSync(path.join(process.cwd(), '.pg-'));
  const data = path.join(root, 'data');
  const port = '55439';
  const blockers: ChildProcess[] = [];
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH, LC_ALL: 'C', LANG: 'C' };
  const run = (name: string, args: string[], input?: string) => {
    const result = spawnSync(`${bin}/${name}`, args, { encoding: 'utf8', input, timeout: 120_000, env });
    if (result.status !== 0) throw new Error(`${name}: ${result.stderr || result.error}\n${existsSync(path.join(root, 'server.log')) ? readFileSync(path.join(root, 'server.log'), 'utf8') : ''}`);
    return result.stdout.trim();
  };
  const args = ['-X', '-qAt', '-h', root, '-p', port, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  const sql = (text: string) => run('psql', args, text);
  const lock = async (text: string) => {
    const child = spawn(`${bin}/psql`, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    blockers.push(child);
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Lock acquisition timed out')), 5000);
      child.stdout!.on('data', chunk => {
        output += chunk;
        if (output.includes('locked')) { clearTimeout(timer); resolve(); }
      });
      child.stderr!.on('data', chunk => { clearTimeout(timer); reject(new Error(String(chunk))); });
      child.stdin!.write(`BEGIN; ${text}; SELECT 'locked';\n`);
    });
    return async () => {
      await new Promise<void>(resolve => { child.on('exit', () => resolve()); child.stdin!.end('ROLLBACK;\n'); });
    };
  };
  try {
    run('initdb', ['-D', data, '--auth=trust', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'server.log'), '-o', `-k ${root} -h '' -p ${port}`, '-w', 'start']);
    // Reuse the original schema and real claim/finish/session helpers, not RPC mocks.
    const source = readFileSync('src/lib/harness/__tests__/requirement-cron-sql.test.ts', 'utf8');
    const original = source.split('const script = String.raw`')[1].split('`;\n  const child')[0];
    const prefix = original.slice(original.indexOf('    const site='), original.indexOf('      // Produce incident rows'));
    const schemaLine = original.split('\n').find(line => line.includes('ALTER TABLE requirements ADD COLUMN budget numeric;'))!;
    const adapter = String.raw`
      import { spawnSync } from 'node:child_process';
      import { readFileSync } from 'node:fs';
      import { randomUUID } from 'node:crypto';
      const psqlArgs=JSON.parse(process.env.LOCAL_PSQL_ARGS);
      const exec=sql=>{
        const result=spawnSync(process.env.LOCAL_PSQL_BIN,psqlArgs,{input:sql,encoding:'utf8'});
        if(result.status!==0) throw new Error(result.stderr);
        return result.stdout.trim();
      };
      const literal=value=>value===null?'NULL':"'"+(Array.isArray(value)?'{'+value.join(',')+'}':typeof value==='object'?JSON.stringify(value):String(value)).replaceAll("'","''")+"'";
      const db={exec:async sql=>exec(sql),query:async(sql,args=[])=>{
        sql=sql.replace(/\$(\d+)/g,(_,n)=>literal(args[Number(n)-1]));
        return {rows:/^SELECT/i.test(sql)?JSON.parse(exec('SELECT coalesce(json_agg(t),\'[]\'::json) FROM ('+sql+') t')):(exec(sql),[])};
      }};
    `;
    const bootstrap = adapter + prefix + schemaLine + String.raw`
      await db.query('INSERT INTO billing VALUES($1,20)',[site]);
      for(const file of ['20261023200000_agent_requirement_nonblocking_wait.sql','20261024010000_requirement_source_checkpoints.sql','20261026010000_requirement_cycle_budget.sql']) await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
      await db.exec('ALTER TABLE sandbox_billing_resources ADD COLUMN deletion_requested_at timestamptz, ADD COLUMN retired_at timestamptz');
      for(const file of ['20261022000001_sandbox_lifecycle_evidence.sql','20261026020000_requirement_economic_recovery.sql','20261026030000_requirement_pause_recovery_commands.sql','20261114210000_requirement_economic_recovery_contention.sql']) await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
      const id=await req(),run=(await claim()).run;
      await session(run,'paused','token_budget_exhausted');
      await finish(run,'paused','token_budget_exhausted');
      await db.query('UPDATE requirements SET budget=10 WHERE id=$1',[id]);
      console.log(JSON.stringify({id,run,site}));
      } catch(error) { throw error; }
    `;
    const setup = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...env, LOCAL_PSQL_BIN: `${bin}/psql`, LOCAL_PSQL_ARGS: JSON.stringify(args) },
    });
    expect({ status: setup.status, stderr: setup.stderr }).toEqual({ status: 0, stderr: '' });
    const fixture = JSON.parse(setup.stdout.trim());
    const id = fixture.id;
    const sessionId = fixture.run.sessionId;

    const evidence = () => JSON.parse(sql(`SELECT json_build_object('requirement',to_jsonb(r),'mapping',to_jsonb(h),'session',to_jsonb(s),'receipt',to_jsonb(p)) FROM requirements r JOIN harness_requirement_runs h ON h.requirement_id=r.id JOIN harness_sessions s ON s.id=h.session_id JOIN requirement_economic_pauses p ON p.requirement_id=r.id WHERE r.id='${id}'`));
    const baseline = evidence();
    const signature = 'claim_agent_requirement_run(uuid[],integer,integer,uuid[])';
    const identity = () => sql(`SELECT oid,proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid='${signature}'::regprocedure`);
    const originalIdentity = identity();
    sql(readFileSync('supabase/migrations/20261128040000_requirement_claim_stage_timings.sql', 'utf8'));
    expect(identity()).toBe(originalIdentity);
    const timedClaim = (max = 10) => {
      const envelope = JSON.parse(sql(`SET ROLE service_role; SET request.headers='{"x-claim-timings":"1"}';
        SELECT claim_agent_requirement_run('{}',${max},300,'{}');`));
      expect(Object.keys(envelope).sort()).toEqual(['claim', 'stage_ms']);
      expect(envelope.stage_ms).toEqual({ economic_pause: expect.any(Number), pending_commands: expect.any(Number), reservation: expect.any(Number) });
      for (const ms of Object.values<number>(envelope.stage_ms)) {
        expect(Number.isInteger(ms) && ms >= 0 && ms <= 60000).toBe(true);
      }
      return envelope.claim;
    };
    const claim = () => timedClaim();
    const dependencies = [
      `SELECT 1 FROM requirement_economic_pauses WHERE requirement_id='${id}' FOR UPDATE`,
      `SELECT 1 FROM harness_requirement_runs WHERE requirement_id='${id}' FOR UPDATE`,
      `SELECT 1 FROM harness_sessions WHERE id='${sessionId}' FOR UPDATE`,
      `SELECT 1 FROM billing WHERE site_id='${fixture.site}' FOR UPDATE`,
    ];
    for (const dependency of dependencies) {
      const release = await lock(dependency);
      const ordinary = sql(`INSERT INTO requirements(id,site_id,user_id,status,metadata,created_at,updated_at) VALUES(gen_random_uuid(),'${fixture.site}','${baseline.requirement.user_id}','backlog','{}','2026-09-15','2026-09-15') RETURNING id;`);
      const started = Date.now();
      const result = claim();
      expect(Date.now() - started).toBeLessThan(1500);
      expect(result.run.requirementId).toBe(ordinary);
      expect(evidence()).toEqual(baseline); // Includes checked_at and all counters.
      // Keep recovery's outer transaction open: candidate rollback must release
      // its requirement lock, not merely rely on the RPC transaction ending.
      const finishRecoveryTransaction = await lock("SELECT recheck_requirement_economic_pauses('{}')");
      sql(`BEGIN; SELECT 1 FROM requirements WHERE id='${id}' FOR UPDATE NOWAIT; ROLLBACK;`);
      await finishRecoveryTransaction();
      await release();
      sql(`DELETE FROM requirements WHERE id='${ordinary}';`);
    }
    // The timed result is not an independent reservation: caller rollback must
    // undo both economic recovery and reservation, including session ownership.
    sql(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.headers='{"x-claim-timings":"1"}';
      SELECT claim_agent_requirement_run('{}',10,300,'{}'); ROLLBACK;`);
    expect(evidence()).toEqual(baseline);
    const recovered = claim();
    expect(recovered.run.requirementId).toBe(id);
    expect(recovered.run.sessionId).toBe(sessionId);
    expect(recovered.run.executionGeneration).toBe(fixture.run.executionGeneration);
    expect(sql(`SELECT count(*) FROM requirement_status WHERE requirement_id='${id}' AND cycle LIKE 'economic-recovery:%'`)).toBe('1');
    expect(timedClaim(1)).toEqual({ state: 'capacity_full' });
    expect(timedClaim()).toBeNull();
    expect(sql("SET ROLE service_role; SELECT claim_agent_requirement_run('{}',10,300,'{}') IS NULL")).toBe('t');
    expect(sql('SHOW lock_timeout')).toBe('0');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(sql(`SELECT has_function_privilege('${role}','recheck_requirement_economic_pauses(uuid[])','EXECUTE')`)).toBe('f');
      expect(sql(`SELECT has_table_privilege('${role}','requirement_economic_pauses','SELECT')`)).toBe('f');
    }
    expect(sql("SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog','lock_timeout=50ms'] FROM pg_proc WHERE oid='recheck_requirement_economic_pauses(uuid[])'::regprocedure")).toBe('t');
    sql(readFileSync(migration, 'utf8'));
  } finally {
    for (const child of blockers) if (child.exitCode === null) child.kill();
    if (existsSync(path.join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
