import { InstanceContextManager } from '../InstanceContextManager';
import { measureInstanceContext } from '../instance-context-budget';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { AIAgentExecutor } from '@/lib/custom-automation/ai-agent-executor';
import { EmbeddingsService } from '@/lib/services/embeddings-service';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/custom-automation/ai-agent-executor', () => ({
  AIAgentExecutor: jest.fn().mockImplementation(() => ({ act: jest.fn().mockResolvedValue({ text: 'Preserve the error and completed tool call.' }) })),
}));
jest.mock('@/lib/services/embeddings-service', () => ({
  EmbeddingsService: { generateEmbeddings: jest.fn().mockResolvedValue({ embeddings: [Array(1536).fill(0.1)] }) },
}));

const admin = supabaseAdmin as jest.Mocked<typeof supabaseAdmin>;
const timestamp = (index: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, index)).toISOString();
const logs = Array.from({ length: 40 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  created_at: timestamp(index),
  log_type: index === 10 ? 'error' : index === 11 ? 'tool_call' : 'agent_action',
  tool_name: index === 11 ? 'browser' : null,
  level: index === 10 ? 'error' : 'info',
  message: `Log ${index} ${'long context '.repeat(42)}`,
  tool_result: null,
  details: {},
}));

function chain(result: unknown) {
  const query: any = {};
  for (const method of ['select', 'eq', 'in', 'order', 'or']) query[method] = jest.fn().mockReturnValue(query);
  query.limit = jest.fn().mockReturnValue(query);
  query.maybeSingle = jest.fn().mockResolvedValue(result);
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return query;
}

function mockPagedLogs(
  history: typeof logs,
  readState: () => { cursor_at: string; cursor_log_id: string } | null = () => null,
  readMemory: () => { id: string; summary: string; end_at: string; end_log_id: string } | null = () => null,
) {
  (admin.from as jest.Mock).mockImplementation((table: string) => {
    if (table === 'instance_context_state') return chain({ data: readState(), error: null });
    if (table === 'instance_context_memories') {
      const memory = readMemory();
      return chain({ data: memory ? [memory] : [], error: null });
    }
    if (table !== 'instance_logs') throw new Error(`Unexpected table: ${table}`);
    const filters: string[] = [];
    let ascending = false;
    let limit = 200;
    const query: any = {};
    query.select = query.eq = query.in = jest.fn().mockReturnValue(query);
    query.or = jest.fn((filter: string) => { filters.push(filter); return query; });
    query.order = jest.fn((column: string, options: { ascending: boolean }) => {
      if (column === 'created_at') ascending = options.ascending;
      return query;
    });
    query.limit = jest.fn((size: number) => { limit = size; return query; });
    query.then = (resolve: (result: unknown) => unknown) => {
      const rows = history.filter(log => filters.every(filter => {
        const match = filter.match(/created_at\.(gt|lt)\.([^,]+),and\(created_at\.eq\.[^,]+,id\.(?:gt|lt)\.([^)]+)\)/);
        if (!match) throw new Error(`Unexpected keyset: ${filter}`);
        const key = `${log.created_at}|${log.id}`;
        const bound = `${match[2]}|${match[3]}`;
        return match[1] === 'gt' ? key > bound : key < bound;
      }));
      rows.sort((a, b) => {
        const first = `${a.created_at}|${a.id}`;
        const second = `${b.created_at}|${b.id}`;
        return ascending ? first.localeCompare(second) : second.localeCompare(first);
      });
      return Promise.resolve({ data: rows.slice(0, limit), error: null }).then(resolve);
    };
    return query;
  });
}

function historyLogs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...logs[0], id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    created_at: new Date(Date.UTC(2026, 8, 25, 12, 0, index)).toISOString(),
    message: `Decision ${index}`,
  }));
}

describe('InstanceContextManager', () => {
  const oldModel = process.env.INSTANCE_CONTEXT_SUMMARY_MODEL;
  const oldPortkey = process.env.PORTKEY_API_KEY;
  const oldAzureEmbeddings = process.env.AZURE_OPENAI_API_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PORTKEY_API_KEY = 'unit-test-key';
    process.env.AZURE_OPENAI_API_KEY = 'unit-test-key';
  });
  afterAll(() => {
    if (oldModel === undefined) delete process.env.INSTANCE_CONTEXT_SUMMARY_MODEL;
    else process.env.INSTANCE_CONTEXT_SUMMARY_MODEL = oldModel;
    if (oldPortkey === undefined) delete process.env.PORTKEY_API_KEY;
    else process.env.PORTKEY_API_KEY = oldPortkey;
    if (oldAzureEmbeddings === undefined) delete process.env.AZURE_OPENAI_API_KEY;
    else process.env.AZURE_OPENAI_API_KEY = oldAzureEmbeddings;
  });

  it('does not advance the cursor when embeddings fail and retains tactical logs', async () => {
    process.env.INSTANCE_CONTEXT_SUMMARY_MODEL = 'summary-model';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (EmbeddingsService.generateEmbeddings as jest.Mock).mockRejectedValueOnce(new Error('embedding unavailable'));
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...logs].reverse(), error: null });
      return chain({ data: [], error: null });
    });
    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(text).toContain('tool_call:browser');
    expect(text).toContain('error');
    expect(admin.rpc).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps tactical evidence when embeddings are unavailable and skips an unpersistable summary call', async () => {
    delete process.env.INSTANCE_CONTEXT_SUMMARY_MODEL;
    delete process.env.PORTKEY_API_KEY;
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...logs].reverse(), error: null });
      return chain({ data: [], error: null });
    });
    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(text).toContain('TACTICAL INSTANCE EVIDENCE');
    expect(text).toContain('Log 10');
    expect(text).toContain('tool_call:browser');
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(AIAgentExecutor).not.toHaveBeenCalled();
  });

  it('persists the model-specific output reserve with the new RPC signature', async () => {
    (admin.rpc as jest.Mock).mockResolvedValue({ data: null, error: null });
    await new InstanceContextManager('instance', 'site').recordUsage({
      provider: 'gemini', model: 'gemini-3.1-pro-preview', usedTokens: 3000,
      availableTokens: 1_048_576, reservedOutputTokens: 0, utilization: 3000 / 1_048_576,
      source: 'estimate', measuredAt: '2026-09-25T12:00:00Z',
    });
    expect(admin.rpc).toHaveBeenCalledWith('record_instance_context_usage', expect.objectContaining({
      p_reserved_output_tokens: 0, p_available_tokens: 1_048_576,
    }));
  });

  it('writes only numeric breakdowns after saving the total, with a matching checkpoint', async () => {
    (admin.rpc as jest.Mock).mockResolvedValue({ data: null, error: null });
    const usage = measureInstanceContext({ provider: 'azure', model: 'deployment',
      system: 'Instructions', messages: [{ role: 'user', content: 'Hi' }], tools: [] });
    await new InstanceContextManager('instance', 'site').recordUsage(usage);
    expect(admin.rpc).toHaveBeenCalledTimes(2);
    expect((admin.rpc as jest.Mock).mock.calls.map(([name]) => name)).toEqual([
      'record_instance_context_usage', 'record_instance_context_breakdown',
    ]);
    const breakdown = (admin.rpc as jest.Mock).mock.calls[1][1];
    expect(breakdown).toEqual(expect.objectContaining({
      p_instance_id: 'instance', p_site_id: 'site', p_measured_at: usage.measuredAt,
      p_breakdown: expect.objectContaining({ usedTokens: usage.usedTokens, measuredAt: usage.measuredAt }),
    }));
    expect(JSON.stringify(breakdown)).not.toContain('Instructions');
  });

  it('keeps legacy totals usable when the breakdown RPC is not deployed', async () => {
    (admin.rpc as jest.Mock).mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: 'PGRST202', message: 'function not found' } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const usage = measureInstanceContext({ provider: 'azure', model: 'deployment', system: '',
        messages: [{ role: 'user', content: 'Hi' }], tools: [] });
      await new InstanceContextManager('instance', 'site').recordUsage(usage);
      expect(warn).not.toHaveBeenCalled();
      expect(admin.rpc).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });

  it('does not persist a breakdown if the total was not written', async () => {
    (admin.rpc as jest.Mock).mockResolvedValue({ error: { code: '42501', message: 'denied' } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const usage = measureInstanceContext({ provider: 'azure', model: 'deployment', system: '', messages: [], tools: [] });
      await new InstanceContextManager('instance', 'site').recordUsage(usage);
      expect(admin.rpc).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('saves usage through the oldest RPC when the deployed table has no output_tokens column', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (admin.rpc as jest.Mock).mockResolvedValueOnce({ error: {
      code: '42703', message: 'column instance_context_state.output_tokens does not exist',
    } }).mockResolvedValueOnce({ error: { code: 'PGRST202', message: 'nine-argument function missing' } })
      .mockResolvedValueOnce({ error: null });
    try {
      await new InstanceContextManager('instance', 'site').recordUsage({
        provider: 'azure', model: 'custom', usedTokens: 700,
        availableTokens: null, reservedOutputTokens: 0, utilization: null,
        source: 'estimate', measuredAt: '2026-09-25T12:00:00Z',
      });
      expect(admin.rpc).toHaveBeenCalledTimes(3);
      expect((admin.rpc as jest.Mock).mock.calls[0][1]).toHaveProperty('p_reserved_output_tokens', 0);
      expect((admin.rpc as jest.Mock).mock.calls[1][1]).toHaveProperty('p_output_tokens', null);
      expect((admin.rpc as jest.Mock).mock.calls[2][1]).not.toHaveProperty('p_output_tokens');
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('does not turn unreported output into zero on a legacy NOT NULL table', async () => {
    (admin.rpc as jest.Mock).mockResolvedValue({ error: { code: '23502', message: 'output_tokens is required' } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await new InstanceContextManager('instance', 'site').recordUsage({
        provider: 'azure', model: 'deployment', usedTokens: 700,
        outputTokens: null, availableTokens: null, reservedOutputTokens: 0, utilization: null,
        source: 'estimate', measuredAt: timestamp(0),
      });
      expect(admin.rpc).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('nullable output_tokens migration'));
    } finally { warn.mockRestore(); }
  });

  it('reads status when both output-token columns are absent', async () => {
    const select = jest.fn().mockImplementation((columns: string) => chain(columns.includes(',output_tokens,')
      ? { data: null, error: { code: '42703' } }
      : { data: { model: 'custom', provider: 'azure', used_tokens: 700,
        available_tokens: null, source: 'estimate', measured_at: timestamp(0) }, error: null }));
    (admin.from as jest.Mock).mockReturnValue({ select });
    const status = await new InstanceContextManager('instance', 'site').status();
    expect(status).toEqual(expect.objectContaining({ model: 'custom', usedTokens: 700, outputTokens: null,
      availableTokens: null, utilization: null }));
    expect(select).toHaveBeenCalledTimes(3);
  });

  it('keeps an available output reserve when only the output_tokens column is missing', async () => {
    const select = jest.fn().mockImplementation((columns: string) => chain(columns.includes(',output_tokens,')
      ? { data: null, error: { code: '42703', message: 'column instance_context_state.output_tokens does not exist' } }
      : { data: { model: 'custom', provider: 'azure', used_tokens: 700,
        available_tokens: 10000, reserved_output_tokens: 1024,
        source: 'estimate', measured_at: timestamp(0) }, error: null }));
    (admin.from as jest.Mock).mockReturnValue({ select });
    const status = await new InstanceContextManager('instance', 'site').status();
    expect(select).toHaveBeenCalledTimes(2);
    expect(status).toEqual(expect.objectContaining({ reservedOutputTokens: 1024,
      outputTokens: null, availableTokens: 10000 }));
  });

  it('persists only the exact contiguous IDs, then reads the summary', async () => {
    process.env.INSTANCE_CONTEXT_SUMMARY_MODEL = 'summary-model';
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...logs].reverse(), error: null });
      return chain({ data: [{ id: 'memory', summary: 'Preserve the error and completed tool call.',
        end_at: logs[24].created_at, end_log_id: logs[24].id }], error: null });
    });
    (admin.rpc as jest.Mock).mockImplementation((name: string) => Promise.resolve({
      data: name === 'commit_instance_context_memory' ? true : [], error: null,
    }));
    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(text).toContain('Preserve the error and completed tool call.');
    expect(admin.rpc).toHaveBeenCalledWith('commit_instance_context_memory', expect.objectContaining({
      p_log_ids: logs.slice(0, -15).map(log => log.id),
      p_end_log_id: logs[24].id,
    }));
    expect(AIAgentExecutor).toHaveBeenCalledTimes(1);
  });

  it('summarizes eligible history automatically with the effective Azure deployment when no summary model is configured', async () => {
    delete process.env.INSTANCE_CONTEXT_SUMMARY_MODEL;
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...logs].reverse(), error: null });
      return chain({ data: [{ id: 'memory', summary: 'Preserve the error and completed tool call.',
        end_at: logs[24].created_at, end_log_id: logs[24].id }], error: null });
    });
    (admin.rpc as jest.Mock).mockImplementation((name: string) => Promise.resolve({
      data: name === 'commit_instance_context_memory' ? true : [], error: null,
    }));
    const text = await new InstanceContextManager('instance', 'site')
      .buildHistory('hello', 'azure', 'private-gpt52-deployment');
    expect(AIAgentExecutor).toHaveBeenCalledWith({ provider: 'azure', model: 'private-gpt52-deployment' });
    expect((AIAgentExecutor as jest.Mock).mock.results[0].value.act).toHaveBeenCalledWith(
      expect.objectContaining({ enforceContextBudget: true, maxIterations: 1 }));
    expect(admin.rpc).toHaveBeenCalledWith('commit_instance_context_memory', expect.objectContaining({
      p_log_ids: logs.slice(0, -15).map(log => log.id),
    }));
    expect(text).toContain('Preserve the error and completed tool call.');
  });

  it('does not mistake a summary-model override for an Azure deployment switch', async () => {
    process.env.INSTANCE_CONTEXT_SUMMARY_MODEL = 'different-azure-name';
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...logs].reverse(), error: null });
      return chain({ data: [{ id: 'memory', summary: 'Preserve the error and completed tool call.',
        end_at: logs[24].created_at, end_log_id: logs[24].id }], error: null });
    });
    (admin.rpc as jest.Mock).mockImplementation((name: string) => Promise.resolve({
      data: name === 'commit_instance_context_memory' ? true : [], error: null,
    }));
    await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'actual-deployment');
    expect(AIAgentExecutor).toHaveBeenCalledWith({ provider: 'azure', model: 'actual-deployment' });
  });

  it('fails closed if cursor exists but memory cannot be read', async () => {
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({
        data: { cursor_at: timestamp(5), cursor_log_id: logs[5].id }, error: null,
      });
      if (table === 'instance_logs') return chain({ data: [...logs].reverse(), error: null });
      return chain({ data: [], error: null });
    });
    await expect(new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o'))
      .rejects.toThrow('Compacted context summary is missing');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('uses vector retrieval as optional historical evidence, keeping the latest memory', async () => {
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({
        data: { cursor_at: timestamp(39), cursor_log_id: logs[39].id }, error: null,
      });
      if (table === 'instance_logs') return chain({ data: [], error: null });
      return chain({ data: [{ id: 'latest', summary: 'Current status: fixed.',
        end_at: timestamp(39), end_log_id: logs[39].id }], error: null });
    });
    (admin.rpc as jest.Mock).mockResolvedValue({ data: [
      { id: 'older', similarity: .8, summary: 'Earlier failed tool call.' },
    ], error: null });
    const text = await new InstanceContextManager('instance', 'site').buildHistory('failed tool', 'azure', 'gpt-4o');
    expect(text).toContain('Current status: fixed.');
    expect(text).toContain('Related historical snapshot');
    expect(admin.rpc).toHaveBeenCalledWith('match_instance_context_memories', expect.objectContaining({
      p_instance_id: 'instance', p_site_id: 'site', p_limit: 3,
    }));
  });

  it('falls back to recent logs before the migration, without calling the compaction RPC', async () => {
    process.env.INSTANCE_CONTEXT_SUMMARY_MODEL = 'summary-model';
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({
        data: null, error: { code: '42P01', message: 'relation does not exist' },
      });
      return chain({ data: [...logs].reverse(), error: null });
    });
    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(text).toContain('RECENT INSTANCE HISTORY');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('does not claim a cursor when the database rejects a non-contiguous segment', async () => {
    process.env.INSTANCE_CONTEXT_SUMMARY_MODEL = 'summary-model';
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...logs].reverse(), error: null });
      return chain({ data: [], error: null });
    });
    (admin.rpc as jest.Mock).mockResolvedValue({ data: false, error: null });
    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(admin.rpc).toHaveBeenCalledWith('commit_instance_context_memory', expect.objectContaining({
      p_log_ids: logs.slice(0, -15).map(log => log.id),
    }));
    expect(text).toContain('tool_call:browser');
    expect(text).not.toContain('RELEVANT EARLIER MEMORY');
  });

  it('never tries to compact across a queued user action', async () => {
    process.env.INSTANCE_CONTEXT_SUMMARY_MODEL = 'summary-model';
    const queued = logs.map((log, index) => index === 10
      ? { ...log, details: { status: 'queued' } } : log);
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...queued].reverse(), error: null });
      return chain({ data: [], error: null });
    });
    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(text).toContain('RECENT INSTANCE HISTORY');
  });

  it('does not compact a streaming log before its final checkpoint', async () => {
    process.env.INSTANCE_CONTEXT_SUMMARY_MODEL = 'summary-model';
    const streaming = logs.map((log, index) => index === 10
      ? { ...log, details: { streaming: true } } : log);
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...streaming].reverse(), error: null });
      return chain({ data: [], error: null });
    });
    await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('does not continue after a cursor with no log ID', async () => {
    (admin.from as jest.Mock).mockImplementation(() => chain({
      data: { cursor_at: timestamp(5), cursor_log_id: null }, error: null,
    }));
    await expect(new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o'))
      .rejects.toThrow('Context cursor is missing its log ID');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('rejects a summary that does not correspond to the current cursor', async () => {
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({
        data: { cursor_at: timestamp(39), cursor_log_id: logs[39].id }, error: null,
      });
      if (table === 'instance_logs') return chain({ data: [], error: null });
      return chain({ data: [{ id: 'stale', summary: 'Incomplete memory',
        end_at: timestamp(38), end_log_id: logs[38].id }], error: null });
    });
    await expect(new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o'))
      .rejects.toThrow('Compacted context summary is missing');
  });

  it('reserves history budget for an older error outside the last 30 logs', async () => {
    const original = process.env.INSTANCE_CONTEXT_SUMMARY_MODEL;
    delete process.env.INSTANCE_CONTEXT_SUMMARY_MODEL;
    delete process.env.PORTKEY_API_KEY;
    const history = logs.map((log, index) => index === 0
      ? { ...log, log_type: 'error', level: 'error', message: 'CRITICAL_FAILURE_FROM_EARLY_TURN' }
      : log);
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...history].reverse(), error: null });
      return chain({ data: [], error: null });
    });
    try {
      const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
      expect(text).toContain('TACTICAL INSTANCE EVIDENCE');
      expect(text).toContain('CRITICAL_FAILURE_FROM_EARLY_TURN');
      expect(admin.rpc).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.INSTANCE_CONTEXT_SUMMARY_MODEL;
      else process.env.INSTANCE_CONTEXT_SUMMARY_MODEL = original;
    }
  });

  it('never commits a log whose decision or tool result lies past the old excerpts', async () => {
    const decision = 'DECISION_AFTER_800_CHARS';
    const toolOutcome = 'RESULT_AFTER_400_CHARS';
    const toolArgument = 'ARGUMENT_AFTER_400_CHARS';
    const history = logs.map((log, index) => index === 0
      ? { ...log, message: `${'a'.repeat(820)}${decision}` }
      : index === 1 ? { ...log, log_type: 'tool_call', tool_name: 'browser',
        tool_args: { payload: `${'c'.repeat(430)}${toolArgument}` },
        tool_result: { payload: `${'b'.repeat(430)}${toolOutcome}` } } : log);
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...history].reverse(), error: null });
      return chain({ data: [], error: null });
    });
    (admin.rpc as jest.Mock).mockResolvedValue({ data: false, error: null });
    await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    const args = (AIAgentExecutor as jest.Mock).mock.results[0]?.value.act.mock.calls[0][0];
    if (args) {
      expect(args.prompt).toContain(decision);
      expect(args.prompt).toContain(toolArgument);
      expect(args.prompt).toContain(toolOutcome);
    } else {
      // If the first log cannot fit in the compaction request it must remain
      // un-compacted and visible, not be committed from a truncated excerpt.
      expect(admin.rpc).not.toHaveBeenCalledWith('commit_instance_context_memory', expect.anything());
    }
  });

  it('includes all un-compacted rows, including decisions earlier than the last 30', async () => {
    delete process.env.PORTKEY_API_KEY;
    const history = logs.map((log, index) => index === 1
      ? { ...log, message: 'UNCOMPACTED_EARLY_DECISION' } : log);
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: null, error: null });
      if (table === 'instance_logs') return chain({ data: [...history].reverse(), error: null });
      return chain({ data: [], error: null });
    });
    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(text).toContain('UNCOMPACTED_EARLY_DECISION');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('compacts successive oldest pages before returning the newest 200 logs', async () => {
    const many = Array.from({ length: 230 }, (_, index) => ({
      ...logs[0], id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      created_at: new Date(Date.UTC(2026, 8, 25, 12, 0, index)).toISOString(),
      message: `Decision ${index}`,
    }));
    let cursor: { cursor_at: string; cursor_log_id: string } | null = null;
    let memory: { id: string; summary: string; end_at: string; end_log_id: string } | null = null;
    const commits: string[][] = [];
    (admin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'instance_context_state') return chain({ data: cursor, error: null });
      if (table === 'instance_context_memories') return chain({ data: memory ? [memory] : [], error: null });
      if (table !== 'instance_logs') throw new Error(`Unexpected table: ${table}`);
      let sortAscending = false;
      let pageLimit = 200;
      let keyset: string | null = null;
      const query: any = {};
      query.select = query.eq = query.in = jest.fn().mockReturnValue(query);
      query.order = jest.fn((column: string, options: { ascending: boolean }) => {
        if (column === 'created_at') sortAscending = options.ascending;
        return query;
      });
      query.limit = jest.fn((size: number) => { pageLimit = size; return query; });
      query.or = jest.fn((filter: string) => { keyset = filter; return query; });
      query.then = (resolve: (result: unknown) => unknown) => {
        const match = keyset?.match(/created_at\.(gt|lt)\.([^,]+),and\(created_at\.eq\.[^,]+,id\.(?:gt|lt)\.([^)]+)\)/);
        const filtered = many.filter(log => {
          const key = `${log.created_at}|${log.id}`;
          const bound = match ? `${match[2]}|${match[3]}` : null;
          return !bound || (match![1] === 'gt' ? key > bound : key < bound);
        });
        filtered.sort((a, b) => sortAscending
          ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id));
        return Promise.resolve({ data: filtered.slice(0, pageLimit), error: null }).then(resolve);
      };
      return query;
    });
    (admin.rpc as jest.Mock).mockImplementation(async (name: string, params: any) => {
      if (name === 'match_instance_context_memories') return { data: [], error: null };
      expect(name).toBe('commit_instance_context_memory');
      const first = many.findIndex(log => cursor && log.id === cursor.cursor_log_id) + 1;
      const expected = many.slice(first, first + params.p_log_ids.length).map(log => log.id);
      expect(params.p_log_ids).toEqual(expected);
      commits.push(params.p_log_ids);
      cursor = { cursor_at: params.p_end_at, cursor_log_id: params.p_end_log_id };
      memory = { id: 'memory', summary: 'Earlier decisions saved.',
        end_at: params.p_end_at, end_log_id: params.p_end_log_id };
      return { data: true, error: null };
    });

    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0][0]).toBe(many[0].id);
    expect(text).toContain('Earlier decisions saved.');
    expect(text).toContain('Decision 229');
  });

  it('pages back from the newest 200 when summarization is unavailable, preserving the first turn', async () => {
    delete process.env.PORTKEY_API_KEY;
    const history = historyLogs(230);
    mockPagedLogs(history);

    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(text).toContain('Decision 0');
    expect(text).toContain('Decision 229');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('pages back without a migration instead of dropping logs before the newest page', async () => {
    const history = historyLogs(230);
    mockPagedLogs(history);
    const pagedFrom = admin.from as jest.Mock;
    const from = pagedFrom.getMockImplementation()!;
    pagedFrom.mockImplementation((table: string) => table === 'instance_context_state'
      ? chain({ data: null, error: { code: '42P01', message: 'relation does not exist' } })
      : from(table));

    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(text).toContain('Decision 0');
    expect(text).toContain('Decision 229');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('pages through rows sharing a timestamp without dropping the keyset boundary', async () => {
    delete process.env.PORTKEY_API_KEY;
    const history = historyLogs(230).map(log => ({ ...log, created_at: timestamp(0) }));
    mockPagedLogs(history);

    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(text).toContain('Decision 0');
    expect(text).toContain('Decision 29');
    expect(text).toContain('Decision 30');
    expect(text).toContain('Decision 229');
  });

  it('includes the unseen page if the database rejects compaction', async () => {
    const history = historyLogs(230);
    mockPagedLogs(history);
    (admin.rpc as jest.Mock).mockResolvedValue({ data: false, error: null });

    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(admin.rpc).toHaveBeenCalledWith('commit_instance_context_memory', expect.anything());
    expect(text).toContain('Decision 0');
    expect(text).toContain('Decision 229');
    expect(text).not.toContain('RELEVANT EARLIER MEMORY');
  });

  it('loads only un-compacted pages after a cursor and skips queued actions', async () => {
    delete process.env.PORTKEY_API_KEY;
    const history = historyLogs(240);
    history[12] = { ...history[12], details: { status: 'queued' } };
    const cursor = { cursor_at: history[4].created_at, cursor_log_id: history[4].id };
    const memory = { id: 'memory', summary: 'Earlier decisions saved.',
      end_at: cursor.cursor_at, end_log_id: cursor.cursor_log_id };
    mockPagedLogs(history, () => cursor, () => memory);
    (admin.rpc as jest.Mock).mockResolvedValue({ data: [], error: null });

    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(text).toContain('Earlier decisions saved.');
    expect(text).toContain('Decision 5');
    expect(text).toContain('Decision 239');
    expect(text).not.toContain('[agent_action] "Decision 4"');
    expect(text).not.toContain('[agent_action] "Decision 12"');
    expect(admin.rpc).not.toHaveBeenCalledWith('commit_instance_context_memory', expect.anything());
  });

  it('keeps paging after the bounded compaction passes instead of losing the gap', async () => {
    const history = historyLogs(2000);
    let cursor: { cursor_at: string; cursor_log_id: string } | null = null;
    let memory: { id: string; summary: string; end_at: string; end_log_id: string } | null = null;
    const commits: string[][] = [];
    mockPagedLogs(history, () => cursor, () => memory);
    (admin.rpc as jest.Mock).mockImplementation(async (name: string, params: any) => {
      if (name === 'match_instance_context_memories') return { data: [], error: null };
      expect(name).toBe('commit_instance_context_memory');
      const first = history.findIndex(log => cursor && log.id === cursor.cursor_log_id) + 1;
      expect(params.p_log_ids).toEqual(history.slice(first, first + params.p_log_ids.length).map(log => log.id));
      commits.push(params.p_log_ids);
      cursor = { cursor_at: params.p_end_at, cursor_log_id: params.p_end_log_id };
      memory = { id: 'memory', summary: 'Earlier decisions saved.',
        end_at: params.p_end_at, end_log_id: params.p_end_log_id };
      return { data: true, error: null };
    });

    const text = await new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o');
    expect(commits.length).toBeGreaterThan(10);
    expect(text).toContain('Earlier decisions saved.');
    expect(text).toContain(`Decision ${commits.flat().length}`);
    expect(text).toContain('Decision 1999');
  });

  it('fails closed when un-compacted history exceeds the bounded fallback', async () => {
    delete process.env.PORTKEY_API_KEY;
    mockPagedLogs(historyLogs(2001));

    await expect(new InstanceContextManager('instance', 'site').buildHistory('hello', 'azure', 'gpt-4o'))
      .rejects.toThrow('Instance history exceeds the safe un-compacted page limit');
  });

  it('retries legacy RPCs without retaining a reserve for a different model', async () => {
    (admin.rpc as jest.Mock).mockResolvedValueOnce({ error: { code: 'PGRST202', message: 'legacy signature' } })
      .mockResolvedValueOnce({ error: null });
    await new InstanceContextManager('instance', 'site').recordUsage({
      provider: 'gemini', model: 'gemini-3.1-pro-preview', usedTokens: 300,
      outputTokens: 12, availableTokens: 1_048_576, reservedOutputTokens: 0,
      utilization: 0, source: 'provider', measuredAt: timestamp(0),
    });
    expect((admin.rpc as jest.Mock).mock.calls[1][1]).not.toHaveProperty('p_reserved_output_tokens');
    // The forward-only SQL migration clears reserved_output_tokens on this path.
  });
});