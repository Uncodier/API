import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

type LogRow = {
  log_type: string;
  tool_result?: Record<string, unknown>;
};

const mockInsert = jest.fn((row: LogRow) => ({
  error: null,
  select: () => ({
    single: async () => ({ data: { id: 'parent-log' }, error: null }),
  }),
}));
const mockUpdate = jest.fn(() => ({
  eq: async () => ({ error: null }),
}));
const mockFrom = jest.fn((table: string) => {
  if (table === 'instance_logs') {
    return { insert: mockInsert, update: mockUpdate };
  }
  if (table === 'instance_plans' || table === 'remote_instances') {
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { status: 'running' }, error: null }),
        }),
      }),
    };
  }
  throw new Error(`Unexpected database table: ${table}`);
});

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: mockFrom },
}));
jest.mock('@/lib/utils/redis-client', () => ({
  getRedisClient: () => { throw new Error('Unexpected Redis access'); },
}));

import { createAssistantOnStepHandler } from '../robot-instance/assistant-logging';
import { createOnStepHandler } from '../robot-plan-execution/step-execution-handler';

const backlogResult = {
  success: true,
  action: 'list',
  requirement_id: 'requirement-1',
  kind: 'app',
  backlog: {
    items: [
      { id: 'item-1', status: 'pending' },
      {
        id: 'item-2',
        status: 'needs_review',
        evidence: { status: 'failed', error: 'Previous verification failed' },
      },
    ],
  },
};

const loggers = [
  {
    name: 'assistant',
    createHandler: () => createAssistantOnStepHandler(
      'instance-1', 'site-1', 'user-1', 'openai',
    ),
  },
  {
    name: 'streaming assistant',
    createHandler: () => {
      const onStep = createAssistantOnStepHandler(
        'instance-1', 'site-1', 'user-1', 'openai',
      );
      return (step: unknown) => onStep(step, { streamingLogId: 'parent-log' });
    },
  },
  {
    name: 'plan step',
    createHandler: () => createOnStepHandler(
      { id: 'remote-instance-1' },
      { order: 1 },
      'plan-1',
      { title: 'Plan', site_id: 'site-1', user_id: 'user-1' },
      'instance-1',
      { value: 'running' },
      { value: '' },
    ),
  },
];

describe.each(loggers)('$name tool operation logging', ({ createHandler }) => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function logToolResult(result?: Record<string, unknown>) {
    await createHandler()({
      text: 'Inspecting requirement backlog',
      toolCalls: [{ id: 'tool-call-1', toolName: 'requirement_backlog', args: {} }],
      toolResults: result ? [{ toolCallId: 'tool-call-1', ...result }] : [],
    });

    const toolLogs = mockInsert.mock.calls
      .map(([row]) => row)
      .filter((row) => row.log_type === 'tool_call');
    expect(toolLogs).toHaveLength(1);
    return toolLogs[0].tool_result;
  }

  it.each(['cleanedResult', 'result', 'content'])(
    'logs explicit backlog success as true from %s despite business-data statuses',
    async (field) => {
      expect(await logToolResult({ [field]: backlogResult })).toMatchObject({
        success: true,
        operation_outcome: 'passed',
        error: null,
      });
    },
  );

  it.each([
    ['empty', {}],
    ['unasserted envelope', { output: {} }],
    ['plain text', 'Backlog retrieved'],
    ['backlog without success flag', { action: 'list', backlog: backlogResult.backlog }],
  ])('logs %s results as unknown, not false', async (_name, result) => {
    expect(await logToolResult({ result })).toMatchObject({
      success: null,
      operation_outcome: 'unknown',
      error: null,
    });
  });

  it('does not infer operational failure from a transport-only result', async () => {
    expect(await logToolResult({ isError: false })).toMatchObject({
      success: null,
      operation_outcome: 'unknown',
      error: null,
    });
  });

  it('leaves success absent when there is no matching tool result', async () => {
    expect(await logToolResult()).toEqual({});
  });

  it('logs explicit operational failure as false', async () => {
    expect(await logToolResult({ result: { success: false, error: 'Rejected' } }))
      .toMatchObject({
        success: false,
        operation_outcome: 'failed',
        error: { message: 'Rejected', path: '$' },
      });
  });

  it('preserves nested failure precedence over explicit success', async () => {
    expect(await logToolResult({
      result: { success: true, output: { error: 'Permission denied' } },
    })).toMatchObject({
      success: false,
      operation_outcome: 'failed',
      error: { message: 'Permission denied', path: '$.output' },
    });
  });

  it('logs transport errors as false even when the payload asserts success', async () => {
    expect(await logToolResult({ isError: true, result: { success: true } }))
      .toMatchObject({ success: false, operation_outcome: 'failed' });
  });
});