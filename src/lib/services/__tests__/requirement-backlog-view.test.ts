import { buildBacklogListView } from '../requirement-backlog-view';
import { emptyBacklog, type BacklogItem } from '../requirement-backlog-types';

function item(id: string, overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id, title: id, kind: 'api', phase_id: 'build', acceptance: ['GET /api returns 200'],
    status: 'pending', attempts: 0, scope_level: 'full', ...overrides,
  };
}

describe('compact backlog view', () => {
  it('prioritizes active work, paginates without dropping IDs, and retains full counts', () => {
    const backlog = emptyBacklog('build');
    backlog.items = [
      ...Array.from({ length: 23 }, (_, i) => item(`pending-${i}`)),
      item('done', { status: 'done' }),
      item('active', { status: 'judge_review' }),
    ];
    const before = JSON.stringify(backlog);
    const first = buildBacklogListView('app', backlog);
    const second = buildBacklogListView('app', backlog, { offset: first.pagination.next_offset! });
    expect(first.backlog.items).toHaveLength(20);
    expect(first.backlog.items[0].id).toBe('active');
    expect(first.summary).toMatchObject({ total_items: 25, active_item_ids: ['active'], runnable_pending_count: 23 });
    expect(first.pagination).toMatchObject({ total_items: 24, next_offset: 20, has_more: true });
    expect(second.backlog.items).toHaveLength(4);
    expect(second.pagination).toMatchObject({ next_offset: null, has_more: false });
    expect(new Set([...first.backlog.items, ...second.backlog.items].map((entry) => entry.id)).size).toBe(24);
    expect(JSON.stringify(backlog)).toBe(before);
  });

  it('keeps quarantined and blocked work visible but never advertises it as runnable', () => {
    const backlog = emptyBacklog('build');
    backlog.items = [
      item('review', { status: 'needs_review' }),
      item('dependent', { depends_on: ['review'] }),
      item('quarantine', { review_quarantine: {
        active: true, kind: 'verification_exhausted', reason: 'No evidence',
        quarantined_at: '2026-09-26T00:00:00Z', external_action_revision: 1,
      } }),
      item('blocked', { blocked_by: [{ blocker_id: 'b', category: 'contract_error', reason: 'Missing payload', resolution_actor: 'verifier' }] }),
      item('cancel', { plan_cancellation_pending: { reason: 'Cancel old work', requested_at: '2026-09-26T00:00:00Z' } }),
      item('exhausted', { attempts: 100000 }),
    ];
    const result = buildBacklogListView('app', backlog);
    expect(result.backlog.items).toHaveLength(6);
    expect(result.summary.runnable_pending_count).toBe(0);
    expect(result.backlog.items.find((entry) => entry.id === 'quarantine')?.review_quarantine?.active).toBe(true);
  });

  it('distinguishes an empty open queue from an empty backlog', () => {
    const backlog = emptyBacklog('build');
    backlog.items = [item('done', { status: 'done' }), item('rejected', { status: 'rejected' })];
    const open = buildBacklogListView('app', backlog);
    expect(open.backlog.items).toEqual([]);
    expect(open.summary.total_items).toBe(2);
    expect(buildBacklogListView('app', backlog, { list_status: 'all' }).backlog.items).toHaveLength(2);
    expect(buildBacklogListView('app', backlog, { list_status: 'rejected' }).backlog.items[0].id).toBe('rejected');
    expect(buildBacklogListView('app', emptyBacklog('build')).summary.total_items).toBe(0);
  });

  it.each([
    { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: NaN },
    { offset: -1 }, { offset: 0.5 }, { offset: Infinity },
    { list_status: 'bogus' as 'all' },
  ])('rejects invalid list options %j', (options) => {
    expect(() => buildBacklogListView('app', emptyBacklog('build'), options)).toThrow();
  });

  it('bounds repeated failure history while retaining the last evidence verdict', () => {
    const backlog = emptyBacklog('build');
    backlog.items = Array.from({ length: 50 }, (_, i) => item(`item-${i}`, {
      title: 'Large title '.repeat(1000),
      assumptions: Array.from({ length: 40 }, () => 'Repeated failure '.repeat(100)),
      acceptance: ['Long acceptance '.repeat(1000)],
      evidence: {
        schema_version: 1, item_id: `item-${i}`, captured_at: '2026-09-26T00:00:00Z',
        critic_passes: 1, judge_verdict: 'rejected', judge_reason: 'No receipt '.repeat(1000),
        tests: [{ command: 'test', exit_code: 1, ran_after_changes: true, output_tail: 'Stack '.repeat(10000) }],
      },
    }));
    const result = buildBacklogListView('app', backlog);
    expect(JSON.stringify(result).length).toBeLessThan(25000);
    expect(JSON.stringify(result).length / JSON.stringify(backlog).length).toBeLessThan(0.02);
    expect(result.backlog.items[0].evidence_summary?.judge_verdict).toBe('rejected');
    expect(result.backlog.items[0].assumptions_count).toBe(40);
    expect(result.backlog.items[0].acceptance_count).toBe(1);
    expect(JSON.stringify(result)).not.toContain('Stack');
  });
});