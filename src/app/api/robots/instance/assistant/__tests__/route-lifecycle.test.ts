import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '@/lib/services/billing/CreditService';
import { start } from 'workflow/api';
import { insertUserActionLog, markRemoteInstanceError } from '../user-message-log';
import { POST } from '../route';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: { validateCredits: jest.fn() } }));
jest.mock('workflow/api', () => ({ start: jest.fn() }));
jest.mock('../workflow', () => ({ runAssistantWorkflow: jest.fn() }));
jest.mock('@/lib/services/requirement-cron-reset', () => ({ resetRequirementOnUserAction: jest.fn() }));
jest.mock('../user-message-log', () => ({
  insertUserActionLog: jest.fn(), markRemoteInstanceError: jest.fn(), withRetries: (fn: () => unknown) => fn(),
}));
jest.mock('../publish-tool-overrides', () => ({ normalizePublishToolOverrides: () => ({}) }));
jest.mock('../skill-selection', () => {
  const { z } = jest.requireActual('zod');
  return { assistantSkillSelectionSchema: z.object({}), approvedCommunityImport: () => null,
    resolveAssistantSkillSelection: async () => ({ skill_mode: 'auto', skills: [] }) };
});
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('@/lib/services/site-skill-access', () => ({ isSiteSkillManager: jest.fn() }));

const INSTANCE = '00000000-0000-4000-8000-000000000001';
const SITE = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000003';
const LOG = '00000000-0000-4000-8000-000000000004';
const request = (body: unknown) => new NextRequest('https://example.com/api/robots/instance/assistant', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const payload = { instance_id: INSTANCE, site_id: SITE, user_id: USER, message: 'Repeated question', request_id: 'request-2' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (CreditService.validateCredits as jest.Mock).mockResolvedValue(true);
  (insertUserActionLog as jest.Mock).mockResolvedValue({ id: LOG });
  (markRemoteInstanceError as jest.Mock).mockResolvedValue(undefined);
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const query: any = {};
    for (const name of ['select', 'eq', 'insert']) query[name] = jest.fn(() => query);
    const data = table === 'sites' ? { user_id: USER }
      : { id: INSTANCE, site_id: SITE, user_id: USER, status: 'error' };
    query.maybeSingle = query.single = jest.fn(async () => ({ data, error: null }));
    return query;
  });
  (start as jest.Mock).mockResolvedValue({ runId: 'run', status: Promise.resolve('completed'),
    returnValue: Promise.resolve({ assistant_response: 'Answer' }) });
});
afterEach(() => jest.restoreAllMocks());

it('persists a fresh turn before workflow start and sends its ID through the SSE acknowledgement', async () => {
  const response = await POST(request(payload));
  const body = await response.text();
  expect(insertUserActionLog).toHaveBeenCalledWith(expect.objectContaining({
    instanceId: INSTANCE, siteId: SITE, skipDuplicateCheck: true,
    details: expect.objectContaining({ request_id: 'request-2', status: 'running' }),
  }));
  expect((insertUserActionLog as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((start as jest.Mock).mock.invocationCallOrder[0]);
  expect((start as jest.Mock).mock.calls[0][1][13]).toMatchObject({ userMessageLogId: LOG });
  expect(body).toContain(`"user_log_id":"${LOG}"`);
  expect(body).toContain('event: completed');
});

it('uses the same lifecycle for a newly created session', async () => {
  const response = await POST(request({ site_id: SITE, message: 'New question' }));
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain('event: accepted');
  expect(body).toContain('event: completed');
  expect((start as jest.Mock).mock.calls[0][1][13]).toMatchObject({ userMessageLogId: LOG });
});

it('delivers workflow failure to the client independently of durable log visibility', async () => {
  (start as jest.Mock).mockResolvedValue({ runId: 'run', status: Promise.resolve('failed') });
  const response = await POST(request(payload));
  expect(await response.text()).toContain('ASSISTANT_WORKFLOW_FAILED');
});

it('returns a startup error even when recording that error also fails', async () => {
  (start as jest.Mock).mockRejectedValue(new Error('PRIVATE_PROVIDER_PAYLOAD'));
  (markRemoteInstanceError as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
  const response = await POST(request(payload));
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body.error.code).toBe('ASSISTANT_START_FAILED');
  expect(JSON.stringify(body)).not.toContain('PRIVATE_PROVIDER_PAYLOAD');
  expect(markRemoteInstanceError).toHaveBeenCalledWith(expect.objectContaining({ instanceId: INSTANCE, siteId: SITE }));
});

it('does not acknowledge or start work when the user message could not be persisted', async () => {
  (insertUserActionLog as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
  const response = await POST(request(payload));
  expect(response.status).toBe(500);
  expect(start).not.toHaveBeenCalled();
  expect(markRemoteInstanceError).toHaveBeenCalled();
});

it('does not write a session log for invalid input or insufficient credits', async () => {
  const invalid = await POST(request({}));
  expect(invalid.status).toBe(400);
  (CreditService.validateCredits as jest.Mock).mockResolvedValue(false);
  const denied = await POST(request(payload));
  expect(denied.status).toBe(402);
  expect(insertUserActionLog).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(markRemoteInstanceError).not.toHaveBeenCalled();
});