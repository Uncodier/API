const mockListBacklog = jest.fn();
const mockGetRequirement = jest.fn();
const mockResetCron = jest.fn();
const mockStartItem = jest.fn();

jest.mock('@/lib/services/requirement-backlog', () => ({
  listBacklog: mockListBacklog,
  markInProgress: mockStartItem,
}));
jest.mock('@/lib/database/requirement-db', () => ({
  getRequirementById: mockGetRequirement,
}));
jest.mock('@/lib/services/requirement-cron-reset', () => ({
  checkAndResetCronAttempts: mockResetCron,
}));
jest.mock('@/lib/services/requirement-backlog-blocker-service', () => ({}));

import { NextRequest } from 'next/server';
import { executeBacklogCore, POST } from '../route';
import { requirementBacklogTool } from '../assistantProtocol';
import { normalizeToolOperationResult } from '@/lib/services/tool-operation-result';
import type { BacklogItem, RequirementBacklog } from '@/lib/services/requirement-backlog-types';

function fixture(): RequirementBacklog {
  const item: BacklogItem = {
    id: 'active', title: 'Storage policy', kind: 'api', phase_id: 'build',
    status: 'in_progress', attempts: 2, scope_level: 'full',
    acceptance: ['Authenticated uploads succeed'],
    assumptions: ['Historical failure '.repeat(1000)],
    tool_failures: { judge_evidence_collector: 2 },
    evidence: {
      schema_version: 1, item_id: 'active', captured_at: '2026-09-26T00:00:00Z',
      critic_passes: 1, judge_verdict: 'rejected', judge_failure_kind: 'evidence_gap',
      judge_reason: 'Missing authenticated upload evidence',
      tests: [{ command: 'npm test', exit_code: 1, ran_after_changes: true, output_tail: 'stack trace '.repeat(1000) }],
    },
  };
  return {
    schema_version: 1, current_phase_id: 'build', completion_ratio: 0.5, cycles_spent_total: 4,
    items: [{ ...item, id: 'done', status: 'done' }, item],
  };
}

describe('requirement backlog read contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListBacklog.mockResolvedValue({ kind: 'app', backlog: fixture() });
    mockGetRequirement.mockResolvedValue({ metadata: { runner_instance_id: 'instance' } });
    mockResetCron.mockResolvedValue(false);
    mockStartItem.mockReset();
  });

  it('returns an explicit successful, compact list without mutating the source', async () => {
    const backlog = fixture();
    const before = JSON.stringify(backlog);
    mockListBacklog.mockResolvedValue({ kind: 'app', backlog });
    const result = await executeBacklogCore({ action: 'list', requirement_id: 'req' });

    expect(normalizeToolOperationResult(result).outcome).toBe('passed');
    expect(result).toMatchObject({
      success: true,
      backlog: { items: [{ id: 'active', attempts: 2, tool_failures: { judge_evidence_collector: 2 } }] },
      summary: { total_items: 2, active_item_ids: ['active'], counts_by_status: { done: 1, in_progress: 1 } },
    });
    expect(JSON.stringify(result)).not.toContain('stack trace');
    expect(JSON.stringify(result).length).toBeLessThan(4000);
    expect(JSON.stringify(backlog)).toBe(before);
    await Promise.resolve();
    expect(mockGetRequirement).not.toHaveBeenCalled();
    expect(mockResetCron).not.toHaveBeenCalled();
  });

  it('exposes full item details on demand without recovery side effects', async () => {
    const result = await executeBacklogCore({ action: 'get', requirement_id: 'req', item_id: 'done' });
    expect(result).toMatchObject({ success: true, action: 'get', item: fixture().items[0] });
    expect(mockGetRequirement).not.toHaveBeenCalled();
    expect(mockResetCron).not.toHaveBeenCalled();
  });

  it('reports mutation success only after a real item was returned', async () => {
    mockStartItem.mockResolvedValueOnce(fixture().items[1]);
    const result = await executeBacklogCore({ action: 'start', requirement_id: 'req', item_id: 'active' });
    expect(normalizeToolOperationResult(result).outcome).toBe('passed');
    expect(mockResetCron).not.toHaveBeenCalled();

    mockStartItem.mockResolvedValueOnce(null);
    await expect(executeBacklogCore({ action: 'start', requirement_id: 'req', item_id: 'missing' }))
      .rejects.toThrow('not found');
  });

  it('rejects missing item ids and missing items rather than reporting success', async () => {
    await expect(executeBacklogCore({ action: 'get', requirement_id: 'req' }))
      .rejects.toThrow('get requires item_id');
    await expect(executeBacklogCore({ action: 'get', requirement_id: 'req', item_id: 'missing' }))
      .rejects.toThrow('not found');
  });

  it('passes list filters and pagination through the assistant protocol', async () => {
    const tool = requirementBacklogTool('site', 'req');
    const result = await tool.execute({ action: 'list', list_status: 'done', limit: 1, offset: 0 });
    expect(result).toMatchObject({
      success: true, backlog: { items: [{ id: 'done' }] },
      pagination: { limit: 1, offset: 0, total_items: 1, has_more: false, next_offset: null },
    });
    expect(tool.parameters.properties.action.enum).toContain('get');
    expect(tool.parameters.properties.list_status.enum).toContain('done');
  });

  it('returns explicit success over HTTP and explicit failure for invalid reads', async () => {
    const response = await POST(new NextRequest('http://localhost/api/agents/tools/requirement_backlog', {
      method: 'POST', body: JSON.stringify({ action: 'list', requirement_id: 'req' }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, action: 'list' });

    const failure = await POST(new NextRequest('http://localhost/api/agents/tools/requirement_backlog', {
      method: 'POST', body: JSON.stringify({ action: 'get', requirement_id: 'req', item_id: 'missing' }),
    }));
    expect(failure.status).toBe(400);
    const result = await failure.json();
    expect(result.success).toBe(false);
    expect(normalizeToolOperationResult(result).outcome).toBe('failed');
  });
});