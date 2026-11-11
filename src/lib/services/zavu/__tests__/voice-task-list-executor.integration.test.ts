import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { executeTools } from '@/lib/agentbase/agents/toolEvaluator/executor/executeTools';
import { FunctionCallStatus } from '@/lib/agentbase/agents/toolEvaluator/types';
import { tasksTool } from '@/app/api/agents/tools/tasks/assistantProtocol';
import { toolsRouterTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { POST } from '@/app/api/agents/tools/tasks/get/route';
import { executeCustomerSupportVoiceTool } from '../voice-tool-executor';

// Keep both executors, the API definition, router, route, core and task-db real.
// Replace only external transport, caller/license lookups and catalog selection.
const mockWorkflow = jest.fn();
const mockCatalog = jest.fn();
jest.mock('composio-core', () => ({ OpenAIToolSet: jest.fn() }));
jest.mock('@/lib/services/workflow-service', () => ({
  WorkflowService: { getInstance: () => ({ executeWorkflow: mockWorkflow }) },
}));
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: {
  schema: () => ({ from: (table: string) => {
    if (table !== 'leads') throw new Error(`Unexpected identity table: ${table}`);
    const query: any = {};
    for (const method of ['select', 'eq']) query[method] = () => query;
    query.maybeSingle = async () => ({ data: { id: mockLeadId }, error: null });
    return query;
  } }),
} }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  rpc: () => ({ abortSignal: async () => ({ data: true, error: null }) }),
  from: () => {
    const query: any = {};
    for (const method of ['select', 'eq', 'abortSignal']) query[method] = () => query;
    query.maybeSingle = async () => ({ data: { user_id: mockUserId }, error: null });
    return query;
  },
} }));
jest.mock('../voice-tool-catalog', () => ({ getCustomerSupportVoiceToolDefinitions: () => mockCatalog() }));
jest.mock('../voice-tool-license', () => ({ requireVoiceToolLicense: async () => async () => {} }));
jest.mock('../inbound-voice-lead', () => ({ findInboundVoiceLead: async () => mockLeadId }));
jest.mock('../voice-lead-identification', () => ({
  normalizeVoiceIdentityPhone: (phone?: string) => phone,
  identifyVoiceLead: jest.fn(),
}));
jest.mock('../voice-call-client', () => ({ getVoiceCall: jest.fn() }));
jest.mock('../voice-execution-context', () => ({ loadVoiceExecutionContext: jest.fn() }));

const siteId = randomUUID();
const mockUserId = randomUUID();
const mockLeadId = randomUUID();
const currentCommand = randomUUID();
const previousCommand = randomUUID();
const otherCommand = randomUUID();
let rows: Record<string, any>[];
let queries: any[];

// PostgREST transport fixture: real query functions apply predicates and pagination.
function builder(table: string) {
  const predicates: Array<(row: Record<string, any>) => boolean> = [];
  let range: [number, number] | undefined;
  const query: any = {
    table,
    select: jest.fn(() => query),
    eq: jest.fn((key, value) => { predicates.push(row => row[key] === value); return query; }),
    neq: jest.fn((key, value) => { predicates.push(row => row[key] != null && row[key] !== value); return query; }),
    in: jest.fn((key, values) => { predicates.push(row => values.includes(row[key])); return query; }),
    order: jest.fn(() => query),
    range: jest.fn((from, to) => { range = [from, to]; return query; }),
    then: (resolve: any, reject: any) => {
      const filtered = (table === 'tasks' ? rows : []).filter(row => predicates.every(test => test(row)));
      return Promise.resolve({ data: range ? filtered.slice(range[0], range[1] + 1) : filtered,
        count: filtered.length, error: null }).then(resolve, reject);
    },
  };
  queries.push(query);
  return query;
}

async function taskRequest(args: Record<string, unknown>) {
  return POST(new NextRequest('https://example.invalid/api/agents/tools/tasks/get', {
    method: 'POST', body: JSON.stringify(args), headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  queries = [];
  rows = [previousCommand, otherCommand].map((command_id, index) => ({
    id: randomUUID(), site_id: siteId, lead_id: mockLeadId, command_id,
    title: `Existing need ${index}`, type: 'call', status: index ? 'in_progress' : 'pending',
    stage: 'consideration', priority: 1, user_id: randomUUID(),
  }));
  rows.push({ ...rows[0], id: randomUUID(), site_id: randomUUID() });
  rows.push({ ...rows[0], id: randomUUID(), lead_id: randomUUID() });
  (createClient as jest.Mock).mockReturnValue({ from: builder });
  // Dispatch the real route, then match apiService's envelope normalization and
  // executeToolActivities/processResponse rather than returning the HTTP body.
  mockWorkflow.mockImplementation(async (_name, { args, apiConfig }) => {
    expect(apiConfig.endpoint.url).toBe('/api/agents/tools/tasks/get');
    const response = await taskRequest(args);
    const body = await response.json();
    const apiResponse = 'success' in body && 'data' in body ? body : { success: true, data: body };
    const mapped = Object.fromEntries(Object.entries(apiConfig.responseMapping as Record<string, string>)
      .map(([name, path]) => [name, path.split('.').reduce<any>((value, part) => value?.[part], apiResponse.data)]));
    return { success: response.ok && apiResponse.success, data: mapped };
  });
  jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
    expect(new URL(String(url)).pathname).toBe('/api/agents/tools/tasks/get');
    return taskRequest(JSON.parse(String(options?.body)));
  });
  // A compatible client catalog exposing explicit query scope. Production's
  // strict voice catalog is separately covered by voice-tool-executor.test.ts.
  mockCatalog.mockReturnValue([{
    name: 'GET_TASKS', description: 'List tasks', parameters: {
      type: 'object', properties: {
        site_id: { type: 'string' }, lead_id: { type: 'string' }, command_id: { type: 'string' },
      },
    },
  }, tasksTool(siteId, mockUserId)]);
});
afterEach(() => jest.restoreAllMocks());

type Path = 'custom-api' | 'unified' | 'routed-object' | 'routed-json' | 'voice-api' | 'voice-unified';
const paths: Path[] = ['custom-api', 'unified', 'routed-object', 'routed-json', 'voice-api', 'voice-unified'];

async function run(path: Path, filters: Record<string, unknown> = {}) {
  const args = { lead_id: mockLeadId, include_completed: false, include_archived: false, ...filters };
  if (path.startsWith('voice-')) {
    return executeCustomerSupportVoiceTool({
      toolName: path === 'voice-api' ? 'GET_TASKS' : 'tasks',
      arguments: path === 'voice-api' ? args : { action: 'list', ...args },
      siteId, context: { command_id: currentCommand }, rawPayload: '{}',
    });
  }
  const unified = tasksTool(siteId, mockUserId);
  const router = toolsRouterTool([unified], { siteId, userId: mockUserId });
  const name = path === 'custom-api' ? 'GET_TASKS' : path === 'unified' ? 'tasks' : 'tools';
  const inner = { action: 'list', ...args };
  const arguments_ = name === 'GET_TASKS' ? args : name === 'tasks' ? inner : {
    action: 'call', name: 'tasks', args: path === 'routed-json' ? JSON.stringify(inner) : inner,
  };
  const [result] = await executeTools([{
    id: 'lookup', type: 'function', status: FunctionCallStatus.INITIALIZED,
    name, arguments: JSON.stringify(arguments_),
  }], { tasks: unified.execute, tools: router.execute }, { site_id: siteId, command_id: currentCommand });
  expect(result.status).toBe('success');
  if (path === 'custom-api') {
    // Assert the agent-facing result, then normalize solely for the shared row
    // assertions below. Summary/filter diagnostics are not part of this mapping.
    expect(result.output.success).toBe(true);
    expect(Array.isArray(result.output.tasks)).toBe(true);
    return { data: result.output };
  }
  return name === 'tools' ? result.output.result : result.output;
}

describe.each(paths)('task query command isolation via %s', path => {
  it('finds older commands across pages, with consistent counts and no implicit command predicate', async () => {
    const first: any = await run(path, { limit: 1 });
    const second: any = await run(path, { limit: 1, offset: 1 });
    expect(first.data.tasks.map((task: any) => task.id)).toEqual([rows[0].id]);
    expect(second.data.tasks.map((task: any) => task.id)).toEqual([rows[1].id]);
    expect(first.data.pagination).toMatchObject({ total: 2, count: 1, has_more: true });
    expect(second.data.pagination).toMatchObject({ total: 2, count: 1, has_more: false });
    if (path !== 'custom-api') {
      expect(first.data.summary.total_tasks).toBe(2);
      expect(first.data.filters_applied).not.toHaveProperty('command_id');
    }
    for (const query of queries.filter(q => q.table === 'tasks')) {
      expect(query.eq).not.toHaveBeenCalledWith('command_id', expect.anything());
      expect(query.eq).toHaveBeenCalledWith('site_id', siteId);
      expect(query.eq).toHaveBeenCalledWith('lead_id', mockLeadId);
    }
  });

  it('preserves an explicit command filter for both rows and statistics', async () => {
    const result: any = await run(path, { command_id: previousCommand, status: 'pending' });
    expect(result.data.tasks.map((task: any) => task.id)).toEqual([rows[0].id]);
    expect(result.data.pagination).toMatchObject({ total: 1, has_more: false });
    if (path !== 'custom-api') {
      expect(result.data.summary.total_tasks).toBe(1);
      expect(result.data.filters_applied.command_id).toBe(previousCommand);
    }
    for (const query of queries.filter(q => q.table === 'tasks')) {
      expect(query.eq).toHaveBeenCalledWith('command_id', previousCommand);
      expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    }
  });
});