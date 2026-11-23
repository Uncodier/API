import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { freshPostgres, postgresBinDirectory } from '@/lib/procurement/__tests__/fixtures/workflow-postgres';

const migration = '20261120233000_assistant_lead_bulk_operations.sql';
const assignmentMigration = '20261123120000_assistant_lead_bulk_team_assignment.sql';
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const site = randomUUID(), otherSite = randomUUID(), instance = randomUUID(), otherInstance = randomUUID();
const owner = randomUUID(), member = randomUUID(), memberId = randomUUID();
const a = randomUUID(), b = randomUUID(), foreign = randomUUID();
const ownerAction = randomUUID(), memberAction = randomUUID(), otherAction = randomUUID(), keyAction = randomUUID();
let db: ReturnType<typeof freshPostgres>;
let scope = { site, instance, user: owner, action: ownerAction };
const targets = { lead_ids: [a, b] };

function userAction(id: string, { user = owner, at = instance, siteId = site,
  admitted = true, message = 'Synthetic user message' } = {}) {
  return `INSERT INTO instance_logs VALUES(${[id, at, siteId, user, 'user_action', message].map(quote).join(',')},
    ${quote(JSON.stringify({ status: 'running', ...(admitted ? { lead_bulk_user_session: true } : {}) }))},true,clock_timestamp());`;
}
function sql(operation: string, payload: unknown, preview?: string, expected = 2) {
  return `SELECT public.assistant_leads_bulk(${[scope.site, scope.user, scope.instance, scope.action, operation, JSON.stringify(payload)].map(quote).join(',')},
    ${preview ? quote(preview) : 'null'},${preview ? expected : 'null'});`;
}
const service = (statement: string) => `SET ROLE service_role; ${statement}`;
const call = (...args: Parameters<typeof sql>) => JSON.parse(db.query(service(sql(...args))).split('\n').at(-1)!);
const count = (table = 'leads') => Number(db.query(`SELECT count(*) FROM ${table};`));

function pgClient(statement: string, finish = true) {
  const socket = db.query('SHOW unix_socket_directories;');
  const child = spawn(join(postgresBinDirectory(), 'psql'),
    ['-XqAt', '-h', socket, '-p', db.query('SHOW port;'), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    { env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: socket, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { errors += value; });
  child.stdin.on('error', () => {});
  const done = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors || `psql exited with ${code}`)));
  });
  void done.catch(() => {});
  child.stdin.write(`SET statement_timeout='10s';\n${statement}\n`);
  if (finish) child.stdin.end();
  return { child, done, output: () => output };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected a database lock wait');
    await delay(20);
  }
}

async function raceWithCommittedChange(first: string, second: string) {
  const holder = pgClient(`BEGIN;\n${first}\n\\echo TRANSACTION_HELD`, false);
  const label = `lead_bulk_${randomUUID()}`;
  let contender: ReturnType<typeof pgClient> | undefined;
  try {
    await waitFor(() => holder.output().includes('TRANSACTION_HELD'));
    contender = pgClient(`SET application_name=${quote(label)};\n${second}`);
    await waitFor(() => db.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=${quote(label)} AND wait_event_type='Lock');`) === 't');
    holder.child.stdin.end('COMMIT;\n');
    const [outputA, outputB] = await Promise.all([holder.done, contender.done]);
    return [outputA, JSON.parse(outputB)];
  } finally {
    if (!holder.child.stdin.writableEnded) holder.child.stdin.end('ROLLBACK;\n');
    await Promise.allSettled([holder.done, ...(contender ? [contender.done] : [])]);
  }
}

beforeAll(() => {
  db = freshPostgres();
  db.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE sites(id uuid PRIMARY KEY, user_id uuid NOT NULL, archived_at timestamptz);
    CREATE TABLE remote_instances(id uuid PRIMARY KEY, site_id uuid NOT NULL, is_archived boolean);
    CREATE TABLE instance_logs(id uuid PRIMARY KEY, instance_id uuid NOT NULL, site_id uuid NOT NULL, user_id uuid,
      log_type text NOT NULL, message text NOT NULL, details jsonb, trusted_user_action boolean NOT NULL,
      created_at timestamptz NOT NULL);
    GRANT SELECT,INSERT,UPDATE ON instance_logs TO authenticated;
    CREATE TABLE site_members(id uuid PRIMARY KEY, site_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
      status text, blocked_screens text[] DEFAULT '{}', restrict_to_assigned_only boolean, licensed boolean NOT NULL,
      UNIQUE(site_id,user_id), UNIQUE(site_id,id));
    CREATE TABLE site_ownership(site_id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY(site_id,user_id));
    CREATE TABLE site_member_location_restrictions(site_id uuid NOT NULL, site_member_id uuid NOT NULL,
      FOREIGN KEY(site_id,site_member_id) REFERENCES site_members(site_id,id));
    CREATE FUNCTION site_member_has_effective_license(p_member_id uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT licensed FROM public.site_members WHERE id=p_member_id $$;
    CREATE FUNCTION site_user_has_effective_access(p_site_id uuid,p_user_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM public.sites s WHERE s.id=p_site_id AND s.archived_at IS NULL AND (s.user_id=p_user_id OR
        EXISTS (SELECT 1 FROM public.site_members m WHERE m.site_id=s.id AND m.user_id=p_user_id AND m.status='active' AND m.licensed)))
    $$;
    CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL, user_id uuid NOT NULL,
      assignee_id uuid, name text, email text, phone text, company jsonb DEFAULT '{}', "position" text, notes text, origin text,
      status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(site_id,name,email));
    CREATE TABLE lead_links(lead_id uuid REFERENCES leads(id) ON DELETE RESTRICT);
    CREATE TABLE lead_events(operation text, lead_id uuid);
    CREATE FUNCTION record_lead_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO public.lead_events VALUES (TG_OP, coalesce(NEW.id, OLD.id)); RETURN NULL; END $$;
    CREATE TRIGGER record_lead_event AFTER INSERT OR UPDATE OR DELETE ON leads FOR EACH ROW EXECUTE FUNCTION record_lead_event();
  `);
  db.migrate(migration);
  db.migrate(assignmentMigration);
}, 30000);

beforeEach(() => {
  scope = { site, instance, user: owner, action: ownerAction };
  db.query(`TRUNCATE assistant_lead_bulk_previews, lead_links, leads, lead_events, instance_logs,
    site_member_location_restrictions, site_members, site_ownership, remote_instances, sites;
    INSERT INTO sites VALUES('${site}','${owner}'),('${otherSite}','${member}');
    INSERT INTO remote_instances VALUES('${instance}','${site}',false),('${otherInstance}','${site}',false);
    INSERT INTO site_members VALUES('${memberId}','${site}','${member}','collaborator','active','{}',true,true);
    INSERT INTO leads(id,site_id,user_id,assignee_id,name,status) VALUES
      ('${a}','${site}','${owner}',null,'Lead A','new'),
      ('${b}','${site}','${owner}','${member}','Lead B','new'),
      ('${foreign}','${otherSite}','${member}',null,'Lead C','new');
    ${userAction(ownerAction)} ${userAction(memberAction, { user: member })}
    ${userAction(otherAction, { at: otherInstance })} ${userAction(keyAction, { admitted: false })}`);
});
afterAll(() => db?.stop());

it('permits only the service RPC and requires a bound, server-admitted user action', () => {
  for (const role of ['anon', 'authenticated']) {
    expect(db.result(`SET ROLE ${role}; ${sql('delete', targets)}`).stderr).toContain('42501');
  }
  expect(db.result(service('SELECT * FROM assistant_lead_bulk_previews;')).stderr).toContain('42501');
  expect(db.result(`SET ROLE authenticated; ${userAction(randomUUID())}`).stderr).toContain('42501');
  expect(db.result(`SET ROLE authenticated; UPDATE instance_logs SET message='changed' WHERE id='${ownerAction}';`).stderr).toContain('42501');
  scope.action = keyAction;
  expect(call('assign_to_me', targets)).toMatchObject({ code: 'access_denied' });
  scope.action = ownerAction;
  db.query(`SET ROLE authenticated; UPDATE instance_logs SET details=details || '{"status":"cancelled"}' WHERE id='${ownerAction}';`);
  expect(call('assign_to_me', targets)).toMatchObject({ code: 'access_denied' });
  expect(db.result(`SET ROLE authenticated; UPDATE instance_logs SET details=details || '{"status":"running"}' WHERE id='${ownerAction}';`).stderr).toContain('42501');
});

it('requires a real preview bound to the user, conversation, target IDs, operation and payload', () => {
  const operation = 'change_status', batch = { ...targets, status: 'qualified' };
  const preview = call(operation, batch);
  expect(preview).toMatchObject({ success: true, matched_count: 2, affected_count: 0, preview_id: expect.any(String) });
  const mismatches: Parameters<typeof sql>[] = [
    [operation, batch, randomUUID()], [operation, { ...batch, lead_ids: [a, foreign] }, preview.preview_id],
    [operation, { ...batch, status: 'lost' }, preview.preview_id], ['assign_to_me', targets, preview.preview_id],
  ];
  for (const args of mismatches) expect(call(...args)).toMatchObject({ code: 'invalid_preview' });
  scope = { ...scope, user: member, action: memberAction };
  expect(call(operation, batch, preview.preview_id)).toMatchObject({ code: 'invalid_preview' });
  scope = { ...scope, user: owner, instance: otherInstance, action: otherAction };
  expect(call(operation, batch, preview.preview_id)).toMatchObject({ code: 'invalid_preview' });
  scope = { site, instance, user: owner, action: ownerAction };
  expect(call(operation, batch, preview.preview_id, 1)).toMatchObject({ code: 'invalid_preview' });
  expect(call(operation, { ...batch, lead_ids: [b, a] }, preview.preview_id)).toMatchObject({ success: true, affected_count: 2 });
  expect(db.query(`SELECT count(*) FROM leads WHERE site_id='${site}' AND status='qualified';`)).toBe('2');
});

it('does not issue a preview for foreign or unassigned rows and rechecks live access', () => {
  scope = { ...scope, user: member, action: memberAction };
  const denied = call('assign_to_me', { lead_ids: [a, b, foreign] });
  expect(denied).toMatchObject({ matched_count: 1, missing_lead_ids: expect.arrayContaining([a, foreign]) });
  expect(denied).not.toHaveProperty('preview_id');
  expect(call('delete', { lead_ids: [b] })).toMatchObject({ code: 'access_denied' });
  const batch = { lead_ids: [b] };
  const preview = call('assign_to_me', batch);
  db.query(`UPDATE site_members SET licensed=false WHERE id='${memberId}';`);
  expect(call('assign_to_me', batch, preview.preview_id, 1)).toMatchObject({ code: 'access_denied' });
  db.query(`UPDATE site_members SET licensed=true WHERE id='${memberId}';
    INSERT INTO site_member_location_restrictions VALUES('${site}','${memberId}');`);
  expect(call('assign_to_me', batch, preview.preview_id, 1)).toMatchObject({ code: 'access_denied' });
  expect(count('lead_events')).toBe(3);
});

it('previews and atomically assigns the exact batch to one teammate, with a durable receipt', () => {
  const operation = 'assign_to_member', batch = { ...targets, assignee_id: member };
  const preview = call(operation, { ...batch, assignee_id: member.toUpperCase() });
  expect(preview).toMatchObject({ success: true, matched_count: 2, affected_count: 0, assignee_id: member, preview_id: expect.any(String) });
  expect(count('lead_events')).toBe(3);
  expect(call(operation, { ...batch, assignee_id: owner }, preview.preview_id)).toMatchObject({ code: 'invalid_preview' });
  const receipt = call(operation, batch, preview.preview_id);
  expect(receipt).toMatchObject({ success: true, affected_count: 2, affected_lead_ids: [a, b].sort(), assignee_id: member, replayed: false });
  expect(db.query(`SELECT count(*) FROM leads WHERE site_id='${site}' AND assignee_id='${member}' AND status='new' AND user_id='${owner}';`)).toBe('2');
  db.query(`UPDATE site_members SET status='inactive' WHERE id='${memberId}';`);
  expect(call(operation, batch, preview.preview_id)).toEqual({ ...receipt, replayed: true });
  expect(count('lead_events')).toBe(5);
});

it('rejects nonmembers, membership IDs and unlicensed recipients before issuing a preview', () => {
  const operation = 'assign_to_member', outsider = randomUUID();
  db.query(`INSERT INTO site_members VALUES ('${randomUUID()}','${otherSite}','${outsider}','collaborator','active','{}',true,true);
    UPDATE site_members SET licensed=false WHERE id='${memberId}';`);
  for (const assignee_id of [outsider, memberId, member]) {
    expect(call(operation, { ...targets, assignee_id })).toEqual({ success: false, code: 'invalid_assignee' });
  }
  expect(db.result(service(sql(operation, targets))).stderr).toContain('22023');
  expect(count('assistant_lead_bulk_previews')).toBe(0);
});

it('keeps the existing lead selection restrictions when assigning to a teammate', () => {
  scope = { ...scope, user: member, action: memberAction };
  const preview = call('assign_to_member', { lead_ids: [a, b, foreign], assignee_id: owner });
  expect(preview).toMatchObject({ matched_count: 1, missing_lead_ids: expect.arrayContaining([a, foreign]) });
  expect(preview).not.toHaveProperty('preview_id');
  expect(count('lead_events')).toBe(3);
});

it('rejects the entire assignment when the teammate loses access during apply', async () => {
  const operation = 'assign_to_member', batch = { ...targets, assignee_id: member };
  const preview = call(operation, batch);
  const [, result] = await raceWithCommittedChange(`UPDATE site_members SET status='inactive' WHERE id='${memberId}';`,
    service(sql(operation, batch, preview.preview_id)));
  expect(result).toMatchObject({ success: false, code: 'invalid_assignee' });
  expect(count('lead_events')).toBe(3);
}, 12000);

it('does not apply a stale delete when a lead changes without advancing updated_at, even if restored', () => {
  const preview = call('delete', targets);
  expect(call('delete', targets, preview.preview_id)).toMatchObject({ code: 'confirmation_required' });
  scope.action = randomUUID(); db.query(userAction(scope.action, { message: preview.confirmation_message }));
  db.query(`UPDATE leads SET status='lost' WHERE id='${a}'; UPDATE leads SET status='new' WHERE id='${a}';`);
  expect(call('delete', targets, preview.preview_id)).toMatchObject({ code: 'selection_changed' });
  expect(count()).toBe(3);
});

it('rolls back the entire delete on a conflicting reference and replays the successful receipt once', () => {
  const preview = call('delete', targets);
  scope.action = randomUUID(); db.query(userAction(scope.action, { message: preview.confirmation_message }));
  db.query(`INSERT INTO lead_links VALUES('${b}');`);
  expect(db.result(service(sql('delete', targets, preview.preview_id))).stderr).toContain('23503');
  expect(count()).toBe(3);
  expect(count('lead_events')).toBe(3);
  db.query('DELETE FROM lead_links;');
  const deleted = call('delete', targets, preview.preview_id);
  expect(deleted).toMatchObject({ success: true, affected_count: 2, replayed: false });
  expect(call('delete', targets, preview.preview_id)).toEqual({ ...deleted, replayed: true });
  expect(count()).toBe(1);
  expect(count('lead_events')).toBe(5);
});

it('recovers the original create receipt after expiry without re-inserting phone-only leads', () => {
  const batch = { leads: [{ name: 'Call contact', phone: '+12025550120', status: 'new' },
    { name: 'Email contact', email: 'contact@example.test', company: 'Example', status: 'new' }] };
  const preview = call('create', batch);
  expect(count()).toBe(3);
  expect(call('create', batch).preview_id).toBe(preview.preview_id);
  const receipt = call('create', batch, preview.preview_id);
  expect(receipt).toMatchObject({ success: true, affected_count: 2, replayed: false });
  db.query(`UPDATE assistant_lead_bulk_previews SET created_at=now()-interval '1 hour' WHERE id='${preview.preview_id}';`);
  expect(call('create', batch, preview.preview_id)).toEqual({ ...receipt, replayed: true });
  expect(call('create', batch).preview_id).toBe(preview.preview_id);
  expect(db.query(`SELECT count(*) FROM leads WHERE phone='+12025550120';`)).toBe('1');
  expect(count('lead_events')).toBe(5);
});

it('rejects an expired unused preview and aborts an entire batch when a target disappears', () => {
  const preview = call('assign_to_me', targets);
  db.query(`UPDATE assistant_lead_bulk_previews SET created_at=now()-interval '1 hour' WHERE id='${preview.preview_id}';`);
  expect(call('assign_to_me', targets, preview.preview_id)).toMatchObject({ code: 'invalid_preview' });
  const fresh = call('assign_to_me', targets);
  db.query(`DELETE FROM leads WHERE id='${b}';`);
  expect(call('assign_to_me', targets, fresh.preview_id)).toMatchObject({ code: 'selection_changed' });
  expect(db.query(`SELECT assignee_id IS NULL FROM leads WHERE id='${a}';`)).toBe('t');
});

it('serializes concurrent retries of a create preview and writes once', async () => {
  const batch = { leads: [{ name: 'Concurrent contact', phone: '+12025550121', status: 'new' }] };
  const preview = call('create', batch);
  const apply = service(sql('create', batch, preview.preview_id, 1));
  const [first, second] = await raceWithCommittedChange(apply, apply);
  const receipt = JSON.parse(first.split('\n')[0]);
  expect(receipt).toMatchObject({ success: true, affected_count: 1, replayed: false });
  expect(second).toEqual({ ...receipt, replayed: true });
  expect(count()).toBe(4);
  expect(count('lead_events')).toBe(4);
}, 12000);

it('compares the locked row after a concurrent edit and deletes nothing', async () => {
  const preview = call('delete', targets);
  scope.action = randomUUID(); db.query(userAction(scope.action, { message: preview.confirmation_message }));
  const [, result] = await raceWithCommittedChange(`UPDATE leads SET status='qualified' WHERE id='${a}';`,
    service(sql('delete', targets, preview.preview_id)));
  expect(result).toMatchObject({ code: 'selection_changed' });
  expect(count()).toBe(3);
}, 12000);

it('rechecks the role after a concurrent revocation before deleting', async () => {
  db.query(`UPDATE site_members SET role='admin',restrict_to_assigned_only=false WHERE id='${memberId}';`);
  scope = { ...scope, user: member, action: memberAction };
  const preview = call('delete', targets);
  scope.action = randomUUID(); db.query(userAction(scope.action, { user: member, message: preview.confirmation_message }));
  const [, result] = await raceWithCommittedChange(`UPDATE site_members SET role='collaborator' WHERE id='${memberId}';`,
    service(sql('delete', targets, preview.preview_id)));
  expect(result).toMatchObject({ code: 'access_denied' });
  expect(count()).toBe(3);
}, 12000);