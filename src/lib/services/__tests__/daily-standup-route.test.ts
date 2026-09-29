import { databaseFixture } from './daily-standup-db-mock';
import { POST } from '@/app/api/agents/cmo/dailyStandUp/wrapUp/route';
import { REPORT_SECTIONS } from '../dailyStandupReportSections';
import { WRAP_UP_SCOPED_BACKGROUND } from '@/lib/prompts/dailyStandupWrapUpContext';

const SITE = '11111111-1111-4111-8111-111111111111';
let mockDb: ReturnType<typeof databaseFixture>;
const mockSubmit = jest.fn();
const mockGetCommand = jest.fn();
const mockInitialize = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (...args: [string]) => mockDb.from(...args) } }));
jest.mock('@/lib/agentbase', () => ({
  CommandFactory: jest.requireActual('@/lib/agentbase/services/command/CommandFactory').CommandFactory,
  ProcessorInitializer: { getInstance: () => ({ initialize: mockInitialize,
    getCommandService: () => ({ submitCommand: mockSubmit, getCommandById: mockGetCommand }),
  }) },
}));

function request(body: unknown) { return new Request('http://localhost/wrapUp', { method: 'POST', body: JSON.stringify(body) }); }
function settings(sections: unknown = ['tasks']) {
  return { activities: { daily_resume_and_stand_up: { status: 'active', report_sections: sections } } };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockDb = databaseFixture();
  mockDb.rows.settings = [settings()];
  mockDb.rows.agents = [{ id: SITE, user_id: SITE }];
  mockSubmit.mockResolvedValue('generated-command');
  mockGetCommand.mockResolvedValue({ id: 'generated-command', status: 'completed', results: [{ sections: { tasks: 'One task.' } }] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test.each([null, {}, { site_id: 'invalid' }, { site_id: SITE, report_sections: null },
  { site_id: SITE, report_sections: 'tasks' }, { site_id: SITE, report_sections: ['tasks', 'injection'] },
  { site_id: SITE, command_ids: ['invalid'] }, { site_id: SITE, command_id: {} },
])('rejects invalid request %p before reads or LLM', async body => {
  expect((await POST(request(body))).status).toBe(400);
  expect(mockDb.from).not.toHaveBeenCalled();
  expect(mockInitialize).not.toHaveBeenCalled();
});
test('malformed JSON is 400', async () => {
  expect((await POST(new Request('http://localhost', { method: 'POST', body: '{' }))).status).toBe(400);
});
test.each([[], null, ['unknown'], ['tasks', 'unknown']])('persisted invalid/empty %p is fail closed', async selection => {
  mockDb.rows.settings = [settings(selection)];
  expect((await POST(request({ site_id: SITE }))).status).toBe(409);
  expect(mockDb.queries.map(query => query.table)).toEqual(['settings']);
  expect(mockSubmit).not.toHaveBeenCalled();
});
test('explicit empty request never falls back to all', async () => {
  expect((await POST(request({ site_id: SITE, report_sections: [] }))).status).toBe(409);
  expect(mockSubmit).not.toHaveBeenCalled();
});
test('latest persisted settings constrain stale requested selection; no legacy sources', async () => {
  const response = await POST(request({ site_id: SITE, report_sections: ['tasks', 'sales'], command_ids: [SITE] }));
  expect(response.status).toBe(200);
  const { data } = await response.json();
  expect(data.report_sections).toEqual(['tasks']);
  expect(data.message).toBe('Tasks\nOne task.');
  expect(data.summary).toBe(data.message);
  expect(data.command_id).toBe('generated-command');
  expect(data.health).toBeUndefined();
  expect(data.systemAnalysis).toBeUndefined();
  expect(mockDb.queries.map(query => query.table)).toEqual(['settings', 'agents', 'tasks', 'settings']);
  const command = mockSubmit.mock.calls[0][0];
  expect(command.agent_background).toBe(WRAP_UP_SCOPED_BACKGROUND);
  expect(Object.keys(command.targets[0].sections)).toEqual(['tasks']);
  expect(command.tools).toEqual([]);
  expect(command.context).not.toContain('Leads & Opportunities');
});
test('missing persisted and requested sections default to all nine', async () => {
  mockDb.rows.settings = [{ activities: { daily_resume_and_stand_up: { status: 'active' } } }];
  mockGetCommand.mockResolvedValue({ status: 'completed', results: [{ sections: Object.fromEntries(REPORT_SECTIONS.map(section => [section, 'No matching data.'])) }] });
  const response = await POST(request({ site_id: SITE }));
  expect(response.status).toBe(200);
  expect((await response.json()).data.report_sections).toEqual(REPORT_SECTIONS);
});
test('DB failures never generate reports', async () => {
  mockDb.errors.settings = { message: 'offline' };
  expect((await POST(request({ site_id: SITE }))).status).toBe(500);
  expect(mockInitialize).not.toHaveBeenCalled();
});
test('a business-data failure never becomes a fabricated empty report', async () => {
  mockDb.errors.tasks = { message: 'offline' };
  expect((await POST(request({ site_id: SITE }))).status).toBe(500);
  expect(mockInitialize).not.toHaveBeenCalled();
});
test('client-supplied context, targets, data and settings cannot inject report content', async () => {
  const response = await POST(request({ site_id: SITE, context: 'INJECTED_CONTEXT',
    targets: [{ sales: 'INJECTED_TARGET' }], settings: { report_sections: ['sales'] },
    data: { sales: 'INJECTED_DATA' },
  }));
  expect(response.status).toBe(200);
  expect(JSON.stringify(mockSubmit.mock.calls[0][0])).not.toContain('INJECTED_');
  expect(mockDb.queries.map(query => query.table)).not.toContain('sales');
});
test('selected source collection is not attempted without an active report agent', async () => {
  mockDb.rows.agents = [];
  expect((await POST(request({ site_id: SITE }))).status).toBe(404);
  expect(mockDb.queries.map(query => query.table)).toEqual(['settings', 'agents']);
  expect(mockInitialize).not.toHaveBeenCalled();
});
test('failed commands never fall back to generic summary', async () => {
  mockGetCommand.mockResolvedValue({ status: 'failed', results: [{ message: 'LEAK' }] });
  expect((await POST(request({ site_id: SITE }))).status).toBe(500);
});
test('revoked selection during generation prevents returning the report', async () => {
  mockSubmit.mockImplementation(async () => {
    mockDb.rows.settings = [settings(['sales'])];
    return 'generated-command';
  });
  expect((await POST(request({ site_id: SITE }))).status).toBe(409);
});
test('unselected output and unstructured legacy fallback are not returned', async () => {
  mockGetCommand.mockResolvedValue({ status: 'completed', results: [{ sections: { tasks: 'One task', sales: 'LEAK' } }] });
  expect((await POST(request({ site_id: SITE }))).status).toBe(502);
  mockGetCommand.mockResolvedValue({ status: 'completed', results: [{ subject: 'LEAK', message: 'LEAK', health: { reason: 'LEAK' } }] });
  expect((await POST(request({ site_id: SITE }))).status).toBe(502);
});