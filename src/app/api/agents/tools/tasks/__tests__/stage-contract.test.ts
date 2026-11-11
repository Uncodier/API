import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { createTask, completeTask } from '@/lib/database/task-db';
import { POST as create, GET as describeCreate } from '../create/route';
import { POST as update } from '../update/route';
import { tasksTool } from '../assistantProtocol';
import { getCustomToolDefinition } from '@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { fireWorkflowDispatch } from '@/lib/services/workflow-robot/dispatch';
import { taskCreationKey } from '../create/persistence';

jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: { from: jest.fn(), auth: { admin: { getUserById: jest.fn(async () => ({ data: null })) } } },
}));
jest.mock('@/lib/services/workflow-robot/dispatch', () => ({ fireWorkflowDispatch: jest.fn() }));
jest.mock('@/lib/services/team-notification-service', () => ({
  TeamNotificationService: { notifyTeam: jest.fn(async () => ({ success: true, notificationsSent: 0, emailsSent: 0, totalMembers: 0 })) },
}));
jest.mock('@/lib/services/notification-service', () => ({
  NotificationService: { createNotification: jest.fn(async () => ({ id: randomUUID() })) },
  NotificationType: { INFO: 'info' }, NotificationPriority: { LOW: 'low', NORMAL: 'normal', HIGH: 'high' },
  NotificationCategory: { TASKS_REMINDERS: 'tasks_reminders' },
}));
jest.mock('@/lib/services/sendgrid-service', () => ({ sendGridService: { sendEmail: jest.fn() } }));
jest.mock('@/lib/services/templates/task-email-templates', () => ({
  generateTaskTeamEmailHtml: jest.fn(), generateTaskUserNotificationHtml: jest.fn(),
}));
jest.mock('../get/core', () => ({ getTaskCore: jest.fn() }));
jest.mock('../../utils/fetch-helper', () => ({ fetchApiTool: jest.fn() }));

// Independent copy of the production CHECK contract, not derived from the implementation.
const stages = ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'];
const siteId = randomUUID(); const userId = randomUUID(); const leadId = randomUUID();
const params = {
  title: 'Review agenda', type: 'call', lead_id: leadId, site_id: siteId, user_id: userId,
  assignee: userId, scheduled_date: '2026-10-30T00:00:00-06:00', status: 'pending',
};
let db: PGlite;
const request = (path: string, body: unknown) => new NextRequest(`https://api.example.test/api/agents/tools/tasks/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payload jsonb NOT NULL,
    site_id uuid NOT NULL, lead_id uuid,
    stage text NOT NULL CONSTRAINT tasks_stage_check CHECK (stage IN ('awareness','consideration','decision','purchase','retention','referral')),
    status text NOT NULL CHECK (status IN ('pending','in_progress','completed','failed','canceled')),
    scheduled_date timestamptz NOT NULL
  )`);
  await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations/20261111010000_task_creation_idempotency.sql'), 'utf8'));
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await db.exec('DELETE FROM tasks');
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    let insertData: any; let updateData: any; let id: string;
    const filters: Record<string, string> = {};
    const query: any = {
      insert: jest.fn((rows: any[]) => { insertData = rows[0]; return query; }),
      update: jest.fn((data: any) => { updateData = data; return query; }),
      select: jest.fn(() => query),
      eq: jest.fn((field: string, value: string) => { id = value; filters[field] = value; return query; }),
      single: async () => {
        if (table === 'leads') return { data: { id: leadId, name: 'Test lead', site_id: siteId, user_id: userId }, error: null };
        try {
          let result;
          if (insertData) {
            result = await db.query<any>('INSERT INTO tasks (payload,stage,status,scheduled_date,site_id,lead_id,creation_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
              [JSON.stringify(insertData), insertData.stage, insertData.status, insertData.scheduled_date, insertData.site_id, insertData.lead_id, insertData.creation_key ?? null]);
          } else if (updateData) {
            result = await db.query<any>(`UPDATE tasks SET payload=payload || $1::jsonb,
              stage=COALESCE($2,stage),status=COALESCE($3,status) WHERE id=$4 RETURNING *`,
              [JSON.stringify(updateData), updateData.stage ?? null, updateData.status ?? null, id]);
          } else if (filters.creation_key) {
            result = await db.query<any>('SELECT * FROM tasks WHERE site_id=$1 AND lead_id=$2 AND creation_key=$3',
              [filters.site_id, filters.lead_id, filters.creation_key]);
          } else {
            result = await db.query<any>('SELECT * FROM tasks WHERE id=$1', [id]);
          }
          const row = result.rows[0];
          return { data: row ? { ...row.payload, id: row.id, stage: row.stage, status: row.status } : null, error: null };
        } catch (error) { return { data: null, error }; }
      },
    };
    return query;
  });
});
afterEach(() => { jest.restoreAllMocks(); });

it('creates the reported reminder without stage using the real PostgreSQL CHECK and preserves its date and assignee', async () => {
  const response = await create(request('create', params));
  const body = await response.json();
  expect(response.status).toBe(201);
  expect(body).toMatchObject({ success: true, task: { ...params, stage: 'awareness' } });
  const result = await db.query<any>('SELECT stage,status,scheduled_date FROM tasks');
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ stage: 'awareness', status: 'pending' });
  expect(new Date(result.rows[0].scheduled_date).toISOString()).toBe('2026-10-30T06:00:00.000Z');
});

it('also supplies a valid stage to direct database callers', async () => {
  expect(await createTask(params)).toMatchObject({ stage: 'awareness', status: 'pending' });
});

it.each(stages)('preserves the explicit customer journey stage %s', async stage => {
  const response = await create(request('create', { ...params, stage }));
  expect(response.status).toBe(201);
  expect((await response.json()).task.stage).toBe(stage);
});

it.each(['pending', 'completed', 'custom_stage'])('rejects invalid create stage %s as HTTP 400 before database access', async stage => {
  const response = await create(request('create', { ...params, stage }));
  expect(response.status).toBe(400);
  expect((await response.json()).details).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['stage'] })]));
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('rejects an invalid update stage before looking up or updating a task', async () => {
  const response = await update(request('update', { task_id: randomUUID(), site_id: siteId, stage: 'completed' }));
  expect(response.status).toBe(400);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('completes a task through status without corrupting its customer journey stage', async () => {
  const task = await createTask({ ...params, stage: 'consideration' });
  expect(await completeTask(task.id)).toMatchObject({ status: 'completed', stage: 'consideration' });
});

it('advertises only actual customer journey stages, not task statuses', async () => {
  expect(tasksTool(siteId, userId).parameters.properties.stage).toMatchObject({ enum: stages });
  const description = await (await describeCreate()).json();
  expect(description.task_stages).toEqual(stages);
  expect(description.example_response.task.stage).toBe('awareness');
});

it('concurrent creates for the same issue insert and notify once, even with different titles', async () => {
  const responses = await Promise.all([
    create(request('create', { ...params, title: 'Verificar resultados pendientes', deduplication_key: 'study-123:results' })),
    create(request('create', { ...params, title: 'Verificar resultados faltantes', deduplication_key: 'study-123:results' })),
  ]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
  const bodies = await Promise.all(responses.map(r => r.json()));
  expect(bodies[0].task.id).toBe(bodies[1].task.id);
  expect(bodies.find(b => !b.created)).toMatchObject({ deduplicated: true });
  expect((await db.query('SELECT * FROM tasks')).rows).toHaveLength(1);
  expect(TeamNotificationService.notifyTeam).toHaveBeenCalledTimes(1);
  expect(fireWorkflowDispatch).toHaveBeenCalledTimes(1);
});

it('does not reopen or overwrite a task when an old create retries after completion', async () => {
  const body = { ...params, deduplication_key: 'study-123:results' };
  const original = await (await create(request('create', body))).json();
  await completeTask(original.task.id);
  const replay = await create(request('create', { ...body, description: 'stale retry' }));
  expect(replay.status).toBe(200);
  expect((await replay.json()).task).toMatchObject({ id: original.task.id, status: 'completed' });
  expect(TeamNotificationService.notifyTeam).toHaveBeenCalledTimes(1);
});

it('preserves the stored description, notes and owner through a duplicate HTTP response and worker mapping', async () => {
  const original = { ...params, deduplication_key: 'study-42:results',
    description: 'Verify study 42', notes: 'Deliver before noon' };
  const created = await (await create(request('create', original))).json();
  const response = await create(request('create', {
    ...original, description: 'Only new information', notes: 'New note', assignee: randomUUID(),
  }));
  expect(response.status).toBe(200);
  const body = await response.json();
  // CREATE response has no data envelope, so apiService wraps it, then the
  // activity unwraps it again before applying the mapping.
  const mapped = Object.fromEntries(Object.entries(getCustomToolDefinition('CREATE_TASK')!.responseMapping)
    .map(([name, path]) => [name, path.split('.').reduce<any>((value, key) => value?.[key], body)]));
  expect(mapped).toMatchObject({ id: created.task.id, created: false, deduplicated: true,
    description: original.description, notes: original.notes, assignee: params.assignee });
  expect(TeamNotificationService.notifyTeam).toHaveBeenCalledTimes(1);
});

it('keeps different issues separate and preserves conversation association', async () => {
  const conversation_id = randomUUID();
  for (const deduplication_key of ['study-123:results', 'study-456:results']) {
    const response = await create(request('create', { ...params, conversation_id, deduplication_key }));
    expect(response.status).toBe(201);
    expect((await response.json()).task.conversation_id).toBe(conversation_id);
  }
  expect((await db.query('SELECT * FROM tasks')).rows).toHaveLength(2);
});

it('deduplicates legacy identical retries without dates or command IDs', async () => {
  const body = { ...params, scheduled_date: undefined };
  const first = await create(request('create', { ...body, command_id: randomUUID() }));
  const second = await create(request('create', { ...body, command_id: randomUUID() }));
  expect(first.status).toBe(201);
  expect(second.status).toBe(200);
  expect(TeamNotificationService.notifyTeam).toHaveBeenCalledTimes(1);
});

it('does not collapse different legacy dates or descriptions', () => {
  expect(taskCreationKey(params)).toBe(taskCreationKey({ ...params, scheduled_date: '2026-10-30T06:00:00Z' }));
  expect(taskCreationKey(params)).not.toBe(taskCreationKey({ ...params, scheduled_date: '2026-11-01T00:00:00Z' }));
  expect(taskCreationKey(params)).not.toBe(taskCreationKey({ ...params, description: 'Another study' }));
});

it('applies the unique identity index to tenant schemas and can be reapplied', async () => {
  await db.exec('CREATE SCHEMA app_task_test; CREATE TABLE app_task_test.tasks (site_id uuid, lead_id uuid)');
  const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261111010000_task_creation_idempotency.sql'), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const sql = 'INSERT INTO app_task_test.tasks (site_id,lead_id,creation_key) VALUES ($1,$2,$3)';
  await db.query(sql, [siteId, leadId, 'test-issue']);
  await expect(db.query(sql, [siteId, leadId, 'test-issue'])).rejects.toMatchObject({ code: '23505' });
  await db.exec('DROP SCHEMA app_task_test CASCADE');
});

it('scopes uniqueness to the site and lead in the actual PostgreSQL index', async () => {
  const sql = 'INSERT INTO tasks (payload,stage,status,scheduled_date,site_id,lead_id,creation_key) VALUES ($1,$2,$3,$4,$5,$6,$7)';
  const values = ['{}', 'awareness', 'pending', params.scheduled_date];
  for (const [site, lead] of [[siteId, leadId], [randomUUID(), leadId], [siteId, randomUUID()]]) {
    await db.query(sql, [...values, site, lead, 'same-key']);
  }
  expect((await db.query('SELECT * FROM tasks')).rows).toHaveLength(3);
});

it('fails closed on persistence errors without dispatching notifications', async () => {
  const from = supabaseAdmin.from as jest.Mock;
  const original = from.getMockImplementation()!;
  from.mockImplementation((table: string) => {
    if (table !== 'tasks') return original(table);
    const query: any = { insert: () => query, select: () => query,
      single: async () => ({ data: null, error: { code: '42703', message: 'Missing creation_key migration' } }) };
    return query;
  });
  expect((await create(request('create', params))).status).toBe(500);
  expect(TeamNotificationService.notifyTeam).not.toHaveBeenCalled();
  expect(fireWorkflowDispatch).not.toHaveBeenCalled();
});