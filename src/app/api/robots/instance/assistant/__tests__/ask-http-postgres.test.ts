import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { start } from 'workflow/api';
import { canToolPrincipalAccessSite, resolveToolRequestPrincipal } from '@/lib/security/tool-request-principal';
import { assistantInstanceAccess } from '@/lib/security/assistant-instance-access';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { askPostgres } from './helpers/ask-postgres';
import { POST } from '../route';
import { firstAskInstanceId } from '../ask-submission';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/security/tool-request-principal', () => ({ canToolPrincipalAccessSite: jest.fn(), resolveToolRequestPrincipal: jest.fn() }));
jest.mock('@/lib/security/assistant-instance-access', () => ({ assistantInstanceAccess: jest.fn() }));
jest.mock('@/lib/connectors/account-access', () => ({ getVisibleConnector: async () => ({}) }));
jest.mock('@/lib/security/site-access', () => ({}));
jest.mock('@/lib/services/site-skill-access', () => ({}));
jest.mock('../execution-routing', () => ({ admitAssistantRouting: async () => ({}), validateAssistantInferenceAdmission: async () => true }));
jest.mock('../skill-selection', () => {
  const { z } = jest.requireActual('zod');
  return { assistantSkillSelectionSchema: z.object({ skill_mode: z.string().default('auto'), skill_slugs: z.array(z.string()).default([]) }),
    approvedCommunityImport: () => null, resolveAssistantSkillSelection: async () => ({ skills: [] }) };
});
jest.mock('workflow/api', () => ({ start: jest.fn() }));
jest.mock('../workflow', () => ({ runAssistantWorkflow: jest.fn() }));

const site = randomUUID(), user = randomUUID(), instance = randomUUID(), connector = randomUUID();
const base = { site_id: site, instance_id: instance, message: 'Summarize this note.', request_id: 'request-1' };
const post = (body: Record<string, unknown>, linked = false) => POST(new NextRequest(`https://example.test/api/robots/instance/assistant${linked ? '/connector' : ''}`, {
  method: 'POST', body: JSON.stringify(body),
}));
let db: ReturnType<typeof askPostgres>;
const count = (table: 'remote_instances' | 'instance_logs') => Number(db.query(`SELECT count(*) FROM ${table}`));
beforeAll(() => { db = askPostgres(); });
afterAll(() => { db?.stop(); });
beforeEach(() => {
  jest.clearAllMocks();
  db.query(`TRUNCATE sites,remote_instances,instance_logs; INSERT INTO sites VALUES ('${site}','${user}');
    INSERT INTO remote_instances(id,site_id,user_id,status) VALUES ('${instance}','${site}','${user}','running');`);
  jest.mocked(supabaseAdmin.from).mockImplementation(db.from as never);
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: false, userSession: true, userId: user, siteId: null });
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(true);
  jest.mocked(assistantInstanceAccess).mockResolvedValue(200);
  jest.mocked(start).mockResolvedValue({ runId: 'fixture-run', status: Promise.resolve('completed'), returnValue: Promise.resolve({}) } as never);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each([false, true])('arbitrates concurrent identical submissions, including session creation: %s', async firstSend => {
  const address = firstSend ? undefined : instance;
  const body = { ...base, instance_id: address, tool_overrides: { a: 1, b: 2 } };
  const responses = await Promise.all(Array.from({ length: 5 }, () => post(body)));
  expect(responses.map(r => r.status).sort()).toEqual([200, 202, 202, 202, 202]);
  const accepted = await responses.find(r => r.status === 200)!.text();
  const replay = await responses.find(r => r.status === 202)!.json();
  expect(replay).toMatchObject({ replayed: true, action_status: 'running', code: 'ASSISTANT_REQUEST_RECORDED' });
  expect(accepted).toContain(`"user_log_id":"${replay.user_log_id}"`);
  expect(count('remote_instances')).toBe(firstSend ? 2 : 1);
  expect(count('instance_logs')).toBe(1);
  // A consumed retry after other turns never revives this action or silently
  // creates another session. Spoofed body attribution is ignored.
  await post({ ...body, instance_id: replay.instance_id, request_id: 'new-intent' });
  db.query(`UPDATE instance_logs SET details=jsonb_set(details,'{status}','"completed"') WHERE id='${replay.user_log_id}'`);
  const again = await post({ ...body, user_id: randomUUID(), instance_id: replay.instance_id, tool_overrides: { b: 2, a: 1 } });
  expect(again.status).toBe(202);
  expect(await again.json()).toMatchObject({ ...replay, action_status: 'completed' });
  expect(count('instance_logs')).toBe(2);
  expect(start).toHaveBeenCalledTimes(2);
  expect((start as jest.Mock).mock.calls[0][1][13].userMessageLogId).toBe(replay.user_log_id);
});

it.each([false, true])('only one concurrently conflicting body can start, first send: %s', async firstSend => {
  const body = { ...base, instance_id: firstSend ? undefined : instance };
  const results = await Promise.all([post(body), post({ ...body, context: 'different context' })]);
  expect(results.map(r => r.status).sort()).toEqual([200,409]);
  expect(await results.find(r => r.status === 409)!.json()).toMatchObject({ error: { code: 'ASSISTANT_REQUEST_CONFLICT' } });
  expect(count('instance_logs')).toBe(1); expect(start).toHaveBeenCalledTimes(1);
});

it('binds all meaningful execution fields, including ordinary vs linked connector requests', async () => {
  expect((await post(base)).status).toBe(200);
  for (const change of [{ message: 'Changed' }, { instance_node_id: randomUUID() }, { execution_mode: 'harness' },
    { tools: ['x'] }, { use_sdk_tools: true }, { expected_results_amount: 2 }, { system_prompt: 'plan' },
    { skill_mode: 'required', skill_slugs: ['other-skill'] }, { connector_id_hint: connector }]) {
    const result = await post({ ...base, ...change }, 'connector_id_hint' in change);
    expect(result.status).toBe(409);
  }
  expect(start).toHaveBeenCalledTimes(1);
});

it.each(['insert', 'start'])('does not redispatch or mark execution failed after a lost %s acknowledgement', async step => {
  if (step === 'insert') db.loseNextActionAck();
  else jest.mocked(start).mockRejectedValueOnce(new Error('Synthetic lost acknowledgement'));
  expect((await post(base)).status).toBe(503);
  expect((await post(base)).status).toBe(202);
  expect(count('instance_logs')).toBe(1);
  expect(start).toHaveBeenCalledTimes(step === 'insert' ? 0 : 1);
});

it('requires a request ID for all interactive direct-capable turns; unkeyed service calls remain non-direct', async () => {
  for (const extra of [{}, { instance_id: undefined }, { connector_id_hint: connector }]) {
    expect((await post({ ...base, ...extra, request_id: undefined }, 'connector_id_hint' in extra)).status).toBe(400);
  }
  expect(start).not.toHaveBeenCalled(); expect(count('instance_logs')).toBe(0); expect(count('remote_instances')).toBe(1);
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: true, userId: null, siteId: null });
  expect((await post({ ...base, request_id: undefined })).status).toBe(200);
  expect((start as jest.Mock).mock.lastCall![1][13]).not.toHaveProperty('catalogUserSession');
  expect(db.query("SELECT details ? 'ask_request_sha256' FROM instance_logs")).toBe('f');
});

it('marks only interactive direct submissions for the new connector contract', async () => {
  expect((await post({ ...base, execution_mode: 'direct' })).status).toBe(200);
  expect((await post({ ...base, request_id: 'harness', execution_mode: 'harness', ask_connection_policy: true })).status).toBe(200);
  expect(db.query("SELECT details->>'ask_connection_policy' FROM instance_logs WHERE details->>'request_id'='request-1'")).toBe('true');
  expect(db.query("SELECT details->>'ask_connection_policy' FROM instance_logs WHERE details->>'request_id'='harness'")).toBe('false');
});

it('only reads a replay after the current row check, including a first-send parent collision', async () => {
  const body = { ...base, instance_id: undefined };
  expect((await post(body)).status).toBe(200);
  jest.mocked(assistantInstanceAccess).mockResolvedValue(404);
  const result = await post(body);
  expect(result.status).toBe(404); expect(await result.text()).not.toContain('user_log_id');
  expect(start).toHaveBeenCalledTimes(1);
  expect(count('instance_logs')).toBe(1);
});

it('same opaque request ID is scoped to the verified actor, site and destination', async () => {
  expect((await post(base)).status).toBe(200);
  const other = randomUUID(), otherSite = randomUUID(), second = randomUUID(), otherInst = randomUUID();
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: false, userSession: true, userId: other, siteId: null });
  expect((await post(base)).status).toBe(200);
  db.query(`INSERT INTO sites VALUES ('${otherSite}','${other}'); INSERT INTO remote_instances(id,site_id,user_id) VALUES
    ('${second}','${site}','${other}'), ('${otherInst}','${otherSite}','${other}');`);
  expect((await post({ ...base, instance_id: second })).status).toBe(200);
  expect((await post({ ...base, instance_id: otherInst, site_id: otherSite })).status).toBe(200);
  expect(new Set((start as jest.Mock).mock.calls.map(c => c[1][13].userMessageLogId)).size).toBe(4);
  expect(firstAskInstanceId(site,user,false,base.request_id)).not.toBe(firstAskInstanceId(otherSite,user,false,base.request_id));
});

it('a 23505 without a scoped action (including an erased winner) cannot authorize another start', async () => {
  expect((await post(base)).status).toBe(200);
  // An opaque uniqueness reservation models the delete-safe receipt-candidate
  // trigger's SQLSTATE. This suite tests the HTTP reaction, not that migration.
  db.query(`CREATE TABLE fixture_reservations(action_id uuid PRIMARY KEY);
    INSERT INTO fixture_reservations SELECT id FROM instance_logs; DELETE FROM instance_logs;
    CREATE FUNCTION fixture_reserve() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO fixture_reservations VALUES (NEW.id); RETURN NULL; END $$;
    CREATE TRIGGER reserve AFTER INSERT ON instance_logs FOR EACH ROW EXECUTE FUNCTION fixture_reserve();`);
  try {
    const response = await post(base);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'ASSISTANT_ADMISSION_UNCONFIRMED' } });
    expect(count('instance_logs')).toBe(0); expect(start).toHaveBeenCalledTimes(1);
  } finally {
    db.query('DROP TRIGGER reserve ON instance_logs; DROP FUNCTION fixture_reserve(); DROP TABLE fixture_reservations;');
  }
});

it('an interrupted first-session creation cannot be adopted and started by a retry', async () => {
  const id = firstAskInstanceId(site, user, false, base.request_id);
  db.query(`INSERT INTO remote_instances(id,site_id,user_id) VALUES ('${id}','${site}','${user}')`);
  const response = await post({ ...base, instance_id: undefined });
  expect(response.status).toBe(503);
  expect(count('instance_logs')).toBe(0); expect(start).not.toHaveBeenCalled();
});


it('rejects too many explicit Record sources without recording or starting an incomplete turn', async () => {
  const message = Array.from({length:9}, () => `/records/${randomUUID()}`).join(' ');
  const response = await post({...base,message});
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({execution_started:false,error:{code:'ASK_RECORD_LINK_LIMIT'}});
  expect(count('instance_logs')).toBe(0);
  expect(start).not.toHaveBeenCalled();
});

it('binds only explicit native Record references to the trusted submission', async () => {
  const ids = [randomUUID(), randomUUID()], forged = randomUUID();
  const message = `Compare /records/${ids[0]} and https://app.makinari.com/records/${ids[1]}`;
  expect((await post({...base,message,ask_linked_record_ids:[forged]})).status).toBe(200);
  expect(JSON.parse(db.query("SELECT details->'ask_linked_record_ids' FROM instance_logs"))).toEqual(ids);
});

it('does not add native sources to another member’s instance, even when the instance is visible', async () => {
  db.query(`UPDATE remote_instances SET user_id='${randomUUID()}' WHERE id='${instance}'`);
  const response = await post({...base,message:`Analyze /records/${randomUUID()}`});
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({execution_started:false,error:{code:'ASK_RECORDS_REQUIRE_OWNER'}});
  expect(count('instance_logs')).toBe(0);
  expect(start).not.toHaveBeenCalled();
});
