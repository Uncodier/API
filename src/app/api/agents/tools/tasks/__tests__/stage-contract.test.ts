import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { createTask, completeTask } from '@/lib/database/task-db';
import { POST as create, GET as describeCreate } from '../create/route';
import { POST as update } from '../update/route';
import { tasksTool } from '../assistantProtocol';

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
    stage text NOT NULL CONSTRAINT tasks_stage_check CHECK (stage IN ('awareness','consideration','decision','purchase','retention','referral')),
    status text NOT NULL CHECK (status IN ('pending','in_progress','completed','failed','canceled')),
    scheduled_date timestamptz NOT NULL
  )`);
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
    const query: any = {
      insert: jest.fn((rows: any[]) => { insertData = rows[0]; return query; }),
      update: jest.fn((data: any) => { updateData = data; return query; }),
      select: jest.fn(() => query),
      eq: jest.fn((_field: string, value: string) => { id = value; return query; }),
      single: async () => {
        if (table === 'leads') return { data: { id: leadId, name: 'Test lead', site_id: siteId, user_id: userId }, error: null };
        try {
          let result;
          if (insertData) {
            result = await db.query<any>('INSERT INTO tasks (payload,stage,status,scheduled_date) VALUES ($1,$2,$3,$4) RETURNING *',
              [JSON.stringify(insertData), insertData.stage, insertData.status, insertData.scheduled_date]);
          } else if (updateData) {
            result = await db.query<any>(`UPDATE tasks SET payload=payload || $1::jsonb,
              stage=COALESCE($2,stage),status=COALESCE($3,status) WHERE id=$4 RETURNING *`,
              [JSON.stringify(updateData), updateData.stage ?? null, updateData.status ?? null, id]);
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