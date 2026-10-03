import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyMigrationExecutionHandoff, findMigrationExecutionHandoff, inspectMigrationExecutionHandoff,
} from '@/lib/services/apps-platform/migration-execution-handoff';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = { requirementId: id(1), instanceId: id(2), requestId: id(3), file: 'migrations/0001.sql',
  operatorId: 'offline-operator', reason: 'Transfer legacy execution authority; normal execution checks still required.' };
const schema = 'app_000000000000400080000000';
const now = new Date('2026-10-03T00:00:00Z');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sql = Buffer.from('\ufeffCREATE TABLE records (id uuid PRIMARY KEY);\r\n');

function fixture() {
  const tables: Record<string, any> = {
    requirements: { id: id(1), site_id: id(4), user_id: id(5), status: 'blocked', cron_lock_active: false,
      cron_lock_expires_at: null, instructions: 'Members may read their own records.',
      metadata: { runner_instance_id: id(2), requirement_execution_generation: 7,
        execution_hold: { kind: 'migration_platform_review', file: input.file } } },
    remote_instances: { id: id(2), site_id: id(4), user_id: id(5), is_archived: false, status: 'running' },
    requirement_migration_lifecycle: { requirement_id: id(1), file: input.file, state: 'platform_review', version: 12,
      review: { decision: 'request_changes' }, attempts: 5, original_sql: 'SELECT archived;',
      checksum: hash('SELECT archived;'), specification_checksum: hash('Archived specification'), reason: 'Preserve diagnosis' },
    requirement_migration_diagnostics: [{ state: 'followup_rejected' }], instance_plans: [],
    requirement_migration_reconciliations: [], requirement_migration_reconciliation_resumes: [],
    requirement_migration_execution_handoffs: null,
    apps_tenants: { tenant_id: id(6), requirement_id: id(1), site_id: id(4), user_id: id(5), schema, status: 'active' },
  };
  const errors: Record<string, any> = {};
  const events: string[] = [];
  const from = jest.fn((table: string) => {
    const chain: any = {};
    for (const method of ['select', 'eq']) chain[method] = jest.fn(() => chain);
    const response = () => {
      events.push(`read:${table}`);
      return Promise.resolve({ data: structuredClone(tables[table]), error: errors[table] || null });
    };
    chain.single = chain.maybeSingle = jest.fn(response);
    chain.then = (yes: any, no: any) => response().then(yes, no);
    return chain;
  });
  const capabilities: any = { version: 1, requirement_id: id(1), tenant_id: id(6), schema,
    identity: { user_id: `${schema}._app_current_user_id`, claims: `${schema}._app_request_claims`, backend: `${schema}._app_is_backend_request` },
    storage: { available: false, bucket: null }, backend: { role: 'authenticated', bypasses_rls: false, operations: [] } };
  const workspace: any = { schema_fingerprint: 'a'.repeat(32), files: [], receipts: [] };
  const appsRpc = jest.fn(async (name: string, params: any): Promise<any> => {
    events.push(name);
    if (name === 'apps_get_tenant_capabilities') return { data: structuredClone(capabilities), error: null };
    if (name === 'apps_get_migration_workspace') return { data: structuredClone(workspace), error: null };
    if (name === 'apps_record_migration_feedback') {
      const row = { target_schema: params.p_target_schema, tenant_id: params.p_expected_tenant_id,
        migration_key: params.p_migration_key, checksum: params.p_migration_checksum,
        context_key: params.p_context_key, error: params.p_error };
      workspace.files = [{ migration_key: row.migration_key, checksum: row.checksum, context_key: row.context_key, error: row.error }];
      return { data: row, error: null };
    }
    throw new Error('Unexpected offline Apps RPC');
  });
  const rpc = jest.fn(async (name: string, params: any): Promise<any> => {
    events.push(name);
    if (name !== 'transfer_requirement_migration_execution') throw new Error('Unexpected offline Makinari RPC');
    tables.requirement_migration_execution_handoffs = { id: params.p_request_id, requirement_id: params.p_requirement_id,
      instance_id: params.p_instance_id, file: params.p_file, operator_id: params.p_operator_id, reason: params.p_reason,
      transferred_version: params.p_expected_version + 1, execution_generation: params.p_expected_execution_generation,
      evidence: params.p_evidence };
    return { data: { receipt_id: params.p_request_id, state: 'transferred', resumed: false }, error: null };
  });
  const deps = { makinari: { from, rpc } as any, apps: { from, rpc: appsRpc } as any,
    appsProjectRef: 'a'.repeat(20), now: () => now,
    readMigration: jest.fn(async () => { events.push('read:bytes'); return Buffer.from(sql); }) };
  return { tables, errors, events, from, rpc, appsRpc, capabilities, workspace, deps };
}
const noWrites = (h: ReturnType<typeof fixture>) => {
  expect(h.rpc).not.toHaveBeenCalled();
  expect(h.appsRpc.mock.calls.some(([name]) => name === 'apps_record_migration_feedback')).toBe(false);
};

it('dry run hashes exact BOM/CRLF bytes and current specification, allows fresh SQL, preserves all archives and writes nothing', async () => {
  const h = fixture(); const prior = structuredClone(h.tables);
  const observation = await inspectMigrationExecutionHandoff(input, h.deps);
  expect(observation.evidence).toMatchObject({ observed_at: now.toISOString(), sql_checksum: hash(sql),
    specification_checksum: hash(h.tables.requirements.instructions), receipt_found: false,
    tenant_id: id(6), schema, file: input.file, sandbox_name: 'req-00000000-00000000' });
  expect(observation.evidence.sql_checksum).not.toBe(h.tables.requirement_migration_lifecycle.checksum);
  expect(observation.evidence).not.toHaveProperty('feedback_registered');
  expect(JSON.stringify(observation)).not.toContain('CREATE TABLE');
  expect(JSON.stringify(observation)).not.toContain('SELECT archived;');
  expect(h.tables).toEqual(prior); noWrites(h);
  expect(h.deps.readMigration).toHaveBeenCalledWith('req-00000000-00000000', input.file);
});

it.each([
  ['status', (h: any) => { h.tables.requirements.status = 'in-progress'; }],
  ['lock', (h: any) => { h.tables.requirements.cron_lock_active = true; }],
  ['lease', (h: any) => { h.tables.requirements.cron_lock_expires_at = new Date(+now + 1).toISOString(); }],
  ['bad lease', (h: any) => { h.tables.requirements.cron_lock_expires_at = 'invalid'; }],
  ['owner', (h: any) => { h.tables.requirements.metadata.runner_instance_id = id(8); }],
  ['site', (h: any) => { h.tables.remote_instances.site_id = id(8); }],
  ['user', (h: any) => { h.tables.remote_instances.user_id = id(8); }],
  ['archived', (h: any) => { h.tables.remote_instances.is_archived = true; }],
  ['generation', (h: any) => { h.tables.requirements.metadata.requirement_execution_generation = -1; }],
  ['lifecycle identity', (h: any) => { h.tables.requirement_migration_lifecycle.requirement_id = id(8); }],
  ['lifecycle state', (h: any) => { h.tables.requirement_migration_lifecycle.state = 'validated'; }],
  ['approved review', (h: any) => { h.tables.requirement_migration_lifecycle.review.decision = 'approved_for_validation'; }],
  ['active diagnosis', (h: any) => { h.tables.requirement_migration_diagnostics.push({ state: 'running' }); }],
  ['followup lease', (h: any) => { h.tables.requirement_migration_diagnostics.push({ state: 'followup_reviewing' }); }],
  ['paused plan', (h: any) => { h.tables.instance_plans.push({ status: 'paused' }); }],
  ['pending reconciliation', (h: any) => { h.tables.requirement_migration_reconciliations.push({ id: id(9) }); }],
  ['other hold', (h: any) => { h.tables.requirements.metadata.execution_hold.file = 'migrations/other.sql'; }],
  ['provenance', (h: any) => { h.tables.requirements.metadata.cron_blocker_provenance = 'manual'; }],
  ['missing spec', (h: any) => { h.tables.requirements.instructions = ' '; }],
  ['oversize spec', (h: any) => { h.tables.requirements.instructions = 'x'.repeat(65537); }],
])('rejects %s before Apps or sandbox I/O', async (_name, change) => {
  const h = fixture(); change(h);
  await expect(inspectMigrationExecutionHandoff(input, h.deps)).rejects.toThrow();
  expect(h.appsRpc).not.toHaveBeenCalled(); expect(h.deps.readMigration).not.toHaveBeenCalled(); noWrites(h);
});

it.each(['site_id', 'user_id', 'requirement_id', 'schema', 'status', 'tenant_id'])('rejects Apps binding mismatch: %s', async field => {
  const h = fixture(); h.tables.apps_tenants[field] = 'invalid';
  await expect(inspectMigrationExecutionHandoff(input, h.deps)).rejects.toThrow('scope mismatch');
  expect(h.deps.readMigration).not.toHaveBeenCalled(); noWrites(h);
});

it('parses capabilities instead of trusting a tenant registry row', async () => {
  const h = fixture(); h.capabilities.backend.bypasses_rls = true;
  await expect(inspectMigrationExecutionHandoff(input, h.deps)).rejects.toThrow('capability receipt');
  expect(h.deps.readMigration).not.toHaveBeenCalled(); noWrites(h);
});

it.each([
  ['same key', { migration_key: `migration:${input.file}`, value: { checksum: hash('other bytes') } }],
  ['checksum rename', { migration_key: 'migration:migrations/renamed.sql', value: { checksum: hash(sql) } }],
  ['unknown legacy checksum', { migration_key: 'migration:legacy.sql', value: {} }],
])('denies existing/uncertain receipt: %s', async (_name, receipt) => {
  const h = fixture(); h.workspace.receipts.push(receipt);
  await expect(inspectMigrationExecutionHandoff(input, h.deps)).rejects.toThrow(); noWrites(h);
});

it('records pending feedback before transfer, rereads durable feedback and sends the exact SQL evidence contract/CAS', async () => {
  const h = fixture(); const priorLife = structuredClone(h.tables.requirement_migration_lifecycle);
  const observation = await inspectMigrationExecutionHandoff(input, h.deps);
  expect(await applyMigrationExecutionHandoff(observation, h.deps)).toEqual({ receipt_id: input.requestId,
    state: 'transferred', resumed: false, already_recorded: false });
  const registration = h.events.indexOf('apps_record_migration_feedback');
  const transfer = h.events.indexOf('transfer_requirement_migration_execution');
  expect(registration).toBeGreaterThan(0);
  expect(h.events.lastIndexOf('apps_get_migration_workspace')).toBeGreaterThan(registration);
  expect(transfer).toBeGreaterThan(h.events.lastIndexOf('apps_get_migration_workspace'));
  expect(h.rpc).toHaveBeenCalledWith('transfer_requirement_migration_execution', {
    p_requirement_id: input.requirementId, p_file: input.file, p_expected_version: 12, p_expected_execution_generation: 7,
    p_instance_id: input.instanceId, p_request_id: input.requestId, p_operator_id: input.operatorId, p_reason: input.reason,
    p_evidence: { ...observation.evidence, feedback_registered: true, feedback_checksum: hash(sql) },
  });
  expect(h.workspace.files[0]).toMatchObject({ checksum: hash(sql), context_key: `operator-handoff:${input.requestId}`,
    error: { kind: 'pending', code: 'OPERATOR_EXECUTION_HANDOFF' } });
  expect(h.tables.requirements.status).toBe('blocked');
  expect(h.tables.requirement_migration_lifecycle).toEqual(priorLife);
});

it.each(['bytes', 'tenant', 'specification', 'version', 'generation', 'schema fingerprint'])('rechecks %s before feedback mutation', async field => {
  const h = fixture(); const observation = await inspectMigrationExecutionHandoff(input, h.deps);
  if (field === 'bytes') h.deps.readMigration.mockResolvedValue(Buffer.from('SELECT changed;'));
  if (field === 'tenant') { h.tables.apps_tenants.tenant_id = id(9); h.capabilities.tenant_id = id(9); }
  if (field === 'specification') h.tables.requirements.instructions += ' Changed.';
  if (field === 'version') h.tables.requirement_migration_lifecycle.version++;
  if (field === 'generation') h.tables.requirements.metadata.requirement_execution_generation++;
  if (field === 'schema fingerprint') h.workspace.schema_fingerprint = 'b'.repeat(32);
  await expect(applyMigrationExecutionHandoff(observation, h.deps)).rejects.toThrow('changed'); noWrites(h);
});

it.each(['missing feedback', 'changed checksum', 'changed context', 'tenant', 'applied receipt', 'changed bytes', 'expired'])('denies %s racing feedback registration', async race => {
  const h = fixture(); const observation = await inspectMigrationExecutionHandoff(input, h.deps);
  const base = h.appsRpc.getMockImplementation()!;
  h.appsRpc.mockImplementation(async (name, params) => {
    const response = await base(name, params);
    if (name === 'apps_record_migration_feedback') {
      if (race === 'missing feedback') h.workspace.files = [];
      if (race === 'changed checksum') h.workspace.files[0].checksum = hash('changed');
      if (race === 'changed context') h.workspace.files[0].context_key = 'other-context';
      if (race === 'tenant') { h.tables.apps_tenants.tenant_id = id(9); h.capabilities.tenant_id = id(9); }
      if (race === 'applied receipt') h.workspace.receipts.push({ migration_key: 'migration:renamed.sql', value: { checksum: hash(sql) } });
      if (race === 'changed bytes') h.deps.readMigration.mockResolvedValue(Buffer.from('SELECT changed;'));
      if (race === 'expired') h.deps.now = () => new Date(+now + 300_001);
    }
    return response;
  });
  await expect(applyMigrationExecutionHandoff(observation, h.deps)).rejects.toThrow();
  expect(h.rpc).not.toHaveBeenCalled();
});

it('timestamps before I/O, rejects slow collection, stale apply and a future observation', async () => {
  const slow = fixture(); slow.deps.readMigration.mockImplementation(async () => {
    slow.deps.now = () => new Date(+now + 300_001); return sql;
  });
  await expect(inspectMigrationExecutionHandoff(input, slow.deps)).rejects.toThrow('expired'); noWrites(slow);
  for (const offset of [300_001, -1]) {
    const h = fixture(); const observation = await inspectMigrationExecutionHandoff(input, h.deps);
    h.deps.now = () => new Date(+now + offset);
    await expect(applyMigrationExecutionHandoff(observation, h.deps)).rejects.toThrow('expired or is future-dated'); noWrites(h);
  }
});

it('durable request UUID lookup after uncertain success never reapplies, even after pause and evidence expiry', async () => {
  const h = fixture(); const observation = await inspectMigrationExecutionHandoff(input, h.deps);
  const base = h.rpc.getMockImplementation()!;
  h.rpc.mockImplementation(async (name, params) => { await base(name, params); throw new Error('Lost response'); });
  await expect(applyMigrationExecutionHandoff(observation, h.deps)).rejects.toThrow('inspect request receipt');
  h.deps.now = () => new Date(+now + 600_000); h.tables.requirements.status = 'paused';
  h.rpc.mockClear(); h.appsRpc.mockClear(); h.deps.readMigration.mockClear();
  expect(await findMigrationExecutionHandoff(input, h.deps)).toMatchObject({ already_recorded: true, resumed: false });
  expect(await applyMigrationExecutionHandoff(observation, h.deps)).toMatchObject({ already_recorded: true });
  noWrites(h); expect(h.appsRpc).not.toHaveBeenCalled(); expect(h.deps.readMigration).not.toHaveBeenCalled();
  await expect(findMigrationExecutionHandoff({ ...input, reason: 'Another operation' }, h.deps)).rejects.toThrow('identity conflict');
});

it('CAS errors and malformed transfer receipts are not success or automatic retries', async () => {
  for (const response of [{ data: null, error: { code: '40001' } },
    { data: { receipt_id: input.requestId, state: 'validated', resumed: false }, error: null }]) {
    const h = fixture(); const observation = await inspectMigrationExecutionHandoff(input, h.deps);
    h.rpc.mockResolvedValue(response);
    await expect(applyMigrationExecutionHandoff(observation, h.deps)).rejects.toThrow(); expect(h.rpc).toHaveBeenCalledTimes(1);
  }
});

it('contains provider errors without leaking synthetic credentials or raw SQL', async () => {
  const username = randomBytes(16).toString('hex'), password = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const url = new URL('https://database.example.invalid'); url.username = username; url.password = password;
  const h = fixture(); h.appsRpc.mockRejectedValue(new Error(`${url.href} Bearer ${token} ${sql.toString()}`));
  let message = '';
  try { await inspectMigrationExecutionHandoff(input, h.deps); } catch (error) { message = String(error); }
  expect(message).toContain('unavailable');
  for (const sensitive of [username, password, token, sql.toString()]) expect(message).not.toContain(sensitive);
  noWrites(h);
});

const root = resolve(__dirname, '../../../../../..');
const script = resolve(root, 'scripts/transfer-requirement-migration.ts');
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath,
  ['--import', 'tsx', script, ...args], { cwd: root, encoding: 'utf8', timeout: 10000,
    env: { NODE_ENV: 'test', PATH: process.env.PATH, ...env } });

it('CLI help is offline; rejects absent/repeated/unsupported arguments and any resume flag', () => {
  const help = run(['--help']); expect(help.status).toBe(0); expect(help.stdout).toContain('dry-run by default');
  for (const args of [[], ['--apply', '--apply'], ['--resume'], ['--env=.env'], ['--plan=ignored']]) {
    const result = run(args); expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Migration execution handoff failed.');
  }
});

it('CLI rejects mismatched/authenticated project URLs without logging individual credentials', () => {
  const username = randomBytes(16).toString('hex'), password = randomBytes(16).toString('hex');
  const key = randomBytes(32).toString('hex');
  const url = new URL('https://database.example.test'); url.username = username; url.password = password;
  const result = run(['--makinari-project=' + 'a'.repeat(20), '--apps-project=' + 'b'.repeat(20),
    `--requirement=${input.requirementId}`, `--instance=${input.instanceId}`, `--request=${input.requestId}`,
    `--file=${input.file}`, `--operator=${input.operatorId}`, `--reason=${input.reason}`],
  { SUPABASE_URL: url.href, SUPABASE_SERVICE_ROLE_KEY: key });
  expect(result.status).toBe(1);
  for (const sensitive of [username, password, key]) expect(result.stdout + result.stderr).not.toContain(sensitive);
});

it('CLI pins resume:false current session and canonical exact-byte reads, with no SQL command or default env loader', () => {
  const source = readFileSync(script, 'utf8');
  expect(source).toContain('resume: false'); expect(source).toContain('sandbox.currentSession()');
  expect(source).toContain("session.runCommand('realpath', ['-e', '--', path]");
  expect(source).toContain('session.readFileToBuffer({ path })');
  expect(source).not.toMatch(/resume: true|Sandbox\.create|dotenv|loadEnvConfig|sandbox\.runCommand|sandbox\.readFileToBuffer/);
});