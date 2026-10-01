import { describe, expect, it, jest } from '@jest/globals';
import { fetchStepLogHistoryText, formatStepLogHistory, STEP_HISTORY_MAX_CHARS, STEP_HISTORY_FAILURE_FILTER } from '../step-history-builder';
import { createInstanceHistoryReader, serializeInstanceHistoryLog } from '@/lib/services/robot-instance/instance-history-reader';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

describe('formatStepLogHistory', () => {
  it('injects sanitized runtime evidence for the next repair turn', () => {
    const result = formatStepLogHistory([
      {
        log_type: 'infrastructure',
        message: 'Step 2 runtime probe failed',
        details: {
          event: 'cron_infra_runtime_probe',
          server_log_excerpt: [
            'POST /api/orders',
            'authorization: Bearer private-token',
            'TypeError: Cannot read properties of undefined',
            '    at createOrder (/vercel/sandbox/src/orders.ts:42:9)',
          ].join('\n'),
        },
      },
    ]);

    expect(result).toContain('[Runtime Evidence: cron_infra_runtime_probe]');
    expect(result).toContain('TypeError: Cannot read properties of undefined');
    expect(result).toContain('/vercel/sandbox/src/orders.ts:42:9');
    expect(result).not.toContain('private-token');
  });

  it('does not invent an enforceable guard from three legacy calls without state/results', () => {
    const repeated = Array.from({ length: 3 }, (_, index) => ({
      log_type: 'tool_call',
      tool_name: 'sandbox_read_file',
      tool_args: {
        path: '/vercel/sandbox/src/app/protected/layout.tsx',
        thought_process: `attempt ${index}`,
      },
    }));

    const result = formatStepLogHistory(repeated);

    expect(result).not.toContain('[Action Loop Guard]');
    expect(result).not.toContain('ACTION_LOOP_BLOCKED_ACTION:');
    expect(result).toContain('sandbox_read_file');
  });

  it('retains source identity and exact source offsets when a tool output is large', () => {
    const log = { id: '11111111-1111-4111-8111-111111111111', log_type: 'tool_call',
      tool_name: 'sandbox_read_files', tool_args: { paths: ['src/start.ts'] },
      tool_result: { output: 'BEGIN_RESULT' + '.'.repeat(40_000) + 'END_RESULT' } };
    const result = formatStepLogHistory([log]);
    const size = serializeInstanceHistoryLog(log).length;
    expect(result.length).toBeLessThanOrEqual(STEP_HISTORY_MAX_CHARS);
    expect(result).toContain('sandbox_read_files');
    expect(result).toContain('src/start.ts');
    expect(result).toContain('BEGIN_RESULT');
    expect(result).toContain('END_RESULT');
    expect(result).toContain(`log_id=${log.id}`);
    expect(result).toContain(`total_chars=${size}`);
    expect(result).toContain(`Tail offset=${size - 4000}`);
    expect(result).toContain('instance_history(');
    expect(result).toContain('PARTIAL REFERENCE');
  });

  it('pins the latest recorded failure ahead of newer chatter without claiming it is unresolved', () => {
    const result = formatStepLogHistory([
      { id: '11111111-1111-4111-8111-111111111111', log_type: 'tool_call', tool_name: 'sandbox_run_tests',
        tool_result: { output: { exitCode: 1, stderr: 'FAIL registration: expected 201, got 500' } } },
      ...Array.from({ length: 80 }, () => ({ log_type: 'agent_action', message: 'Later progress '.repeat(500) })),
    ]);
    expect(result.length).toBeLessThanOrEqual(STEP_HISTORY_MAX_CHARS);
    expect(result).toContain('FAIL registration');
    expect(result).toContain('LATEST RECORDED FAILURE');
    expect(result).toContain('not proof it is still unresolved');
    expect(result).toContain('DIAGNOSTIC NEXT ACTION');
    expect(result).toContain('records omitted');
    expect(result).toContain('--- END PREVIOUS ACTIONS ---');
  });

  it('keeps useful error lines and redacts secrets in tool and argument excerpts', () => {
    const result = formatStepLogHistory([{ log_type: 'tool_call', tool_name: 'sandbox_run_command',
      tool_args: { command: 'npm test', password: 'do-not-echo' },
      tool_result: { output: { exitCode: 1, stderr: 'noise\n'.repeat(2000) +
        'TypeError: order is undefined\n at orders.ts:42\nauthorization: Bearer private-token' } } }]);
    expect(result).toContain('TypeError: order is undefined');
    expect(result).not.toContain('do-not-echo');
    expect(result).not.toContain('private-token');
  });

  it('does not replace detailed stderr with a normalized generic exit-code error', () => {
    const result = formatStepLogHistory([{ log_type: 'tool_call', tool_name: 'sandbox_run_tests',
      tool_result: { success: false, error: { message: 'Command exited with code 1' },
        output: { exitCode: 1, stderr: 'FAIL orders.test.ts: expected 201, got 500' } } }]);
    expect(result).toContain('Command exited with code 1');
    expect(result).toContain('FAIL orders.test.ts');
  });

  it('handles malformed legacy payloads without inventing source references', () => {
    const circular: any = {}; circular.self = circular;
    expect(formatStepLogHistory([{ id: 'bad-id', log_type: 'tool_call', tool_name: 'read',
      tool_args: circular }])).toContain('Source log ID unavailable');
  });

  it('loads tenant-scoped history in stable timestamp/id order', async () => {
    const query: any = { select: jest.fn(), eq: jest.fn(), in: jest.fn(), filter: jest.fn(), order: jest.fn(), or: jest.fn(),
      limit: jest.fn<() => Promise<any>>().mockResolvedValue({ data: [], error: null }) };
    for (const method of ['select', 'eq', 'in', 'filter', 'order', 'or']) query[method].mockReturnValue(query);
    (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
    expect(await fetchStepLogHistoryText('instance', 'plan', 'step', 'site')).toBe('');
    expect(query.eq).toHaveBeenCalledWith('site_id', 'site');
    expect(query.order).toHaveBeenCalledWith('id', { ascending: false });
    query.limit.mockResolvedValue({ data: null, error: { message: 'private DB error' } });
    const result = await fetchStepLogHistoryText('instance', 'plan', 'step', 'site');
    expect(result).toContain('HISTORY UNAVAILABLE');
    expect(result).not.toContain('private DB error');
  });

  it('retrieves the latest failure independently of 100 newer records', async () => {
    const old = { id: '11111111-1111-4111-8111-111111111111', created_at: '2026-09-01T00:00:00Z',
      log_type: 'tool_call', tool_name: 'sandbox_run_tests', tool_result: { success: false, output: 'FAIL older registration' } };
    const recent = Array.from({ length: 100 }, (_, i) => ({ id: `recent-${i}`, created_at: '2026-09-02T00:00:00Z',
      log_type: 'agent_action', message: 'newer chatter' }));
    const query: any = {};
    for (const method of ['select', 'eq', 'in', 'filter', 'order', 'or']) query[method] = jest.fn().mockReturnValue(query);
    query.limit = jest.fn((limit: number) => Promise.resolve({ data: limit === 10 ? [old] : recent, error: null }));
    (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
    const result = await fetchStepLogHistoryText('instance', 'plan', 'step', 'site');
    expect(result).toContain('FAIL older registration');
    expect(result).toContain(`log_id=${old.id}`);
    expect(result.length).toBeLessThanOrEqual(STEP_HISTORY_MAX_CHARS);
  });

  it.each([
    ['details->>error.not.is.null', { log_type: 'infrastructure', details: { error: 'FAIL legacy server' } }],
    ['details->>error_excerpt.not.is.null', { log_type: 'infrastructure', details: { error_excerpt: 'FAIL legacy server' } }],
    ['tool_result->output->>exitCode.neq.0', { log_type: 'tool_call', tool_name: 'sandbox_run_tests',
      tool_result: { output: { exitCode: 1, stderr: 'FAIL legacy server' } } }],
  ])('queries older legacy failures through %s rather than relying on the recent window', async (predicate, old) => {
    const query: any = {};
    let filter = '';
    for (const method of ['select', 'eq', 'in', 'filter', 'order']) query[method] = jest.fn().mockReturnValue(query);
    query.or = jest.fn((value: string) => { filter = value; return query; });
    query.limit = jest.fn((limit: number) => Promise.resolve({ data: limit === 10 && filter.includes(predicate)
      ? [{ id: '11111111-1111-4111-8111-111111111111', ...old }] : [], error: null }));
    (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
    expect(STEP_HISTORY_FAILURE_FILTER).toContain(predicate);
    expect(await fetchStepLogHistoryText('instance', 'plan', 'step', 'site')).toContain('FAIL legacy server');
  });

  it('advertised source offsets retrieve the actual canonical failure through the scoped reader', async () => {
    const log = { id: '11111111-1111-4111-8111-111111111111', created_at: '2026-09-30T00:00:00Z',
      log_type: 'tool_call', tool_name: 'sandbox_run_tests', message: 'npm test',
      tool_args: { command: 'npm test' }, tool_result: { success: false, output: 'x'.repeat(15_000) + 'FAIL last assertion' } };
    const formatted = formatStepLogHistory([log]);
    const offset = Number(formatted.match(/Tail offset=(\d+)/)?.[1]);
    expect(offset).toBeGreaterThan(0);
    const query: any = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn<() => Promise<any>>().mockResolvedValue({ data: log }) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
    (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
    const site = '22222222-2222-4222-8222-222222222222';
    const instance = '33333333-3333-4333-8333-333333333333';
    const result = await createInstanceHistoryReader(site, instance)({ action: 'read', log_id: log.id, offset, limit: 4000 });
    expect(result.action).toBe('read');
    if (result.action !== 'read') throw new Error('Expected history read');
    expect(result.content).toContain('FAIL last assertion');
    expect(result.has_more).toBe(false);
    expect(formatted).toContain(`total_chars=${result.total_chars}`);
    expect(query.eq).toHaveBeenCalledWith('site_id', site);
    expect(query.eq).toHaveBeenCalledWith('instance_id', instance);
  });

});
