import { describe, expect, it } from '@jest/globals';
import {
  isItemTerminal,
  gatingItems,
  isBacklogComplete,
  outstandingGatingItems,
  hasOutstandingWork,
  hasApprovedJudgeEvidence,
  isOrnamentalOnlyOutstanding,
  pendingInPhase,
  type BacklogItem
} from '../requirement-backlog';

describe('Requirement Backlog Helpers', () => {
  const createItem = (id: string, tier: 'core' | 'ornamental' | undefined, status: string): BacklogItem => ({
    id,
    title: `Item ${id}`,
    kind: 'page',
    phase_id: 'phase1',
    acceptance: [],
    status: status as any,
    attempts: 0,
    scope_level: 'full',
    tier,
  });

  describe('isItemTerminal', () => {
    it('returns true for terminal statuses', () => {
      expect(isItemTerminal('done')).toBe(true);
      expect(isItemTerminal('needs_review')).toBe(true);
    });

    it('returns false for non-terminal statuses', () => {
      expect(isItemTerminal('pending')).toBe(false);
      expect(isItemTerminal('in_progress')).toBe(false);
      expect(isItemTerminal('rejected')).toBe(false);
    });
  });

  describe('gatingItems', () => {
    it('returns only core items if any core items exist', () => {
      const items = [
        createItem('1', 'core', 'pending'),
        createItem('2', 'ornamental', 'done'),
        createItem('3', undefined, 'pending'), // undefined tier implies core
      ];
      const gating = gatingItems(items);
      expect(gating.length).toBe(2);
      expect(gating.map(i => i.id)).toEqual(['1', '3']);
    });

    it('returns all items if no core items exist (content fallback)', () => {
      const items = [
        createItem('1', 'ornamental', 'pending'),
        createItem('2', 'ornamental', 'done'),
      ];
      const gating = gatingItems(items);
      expect(gating.length).toBe(2);
      expect(gating.map(i => i.id)).toEqual(['1', '2']);
    });
  });

  describe('isBacklogComplete', () => {
    it('returns false for empty backlog', () => {
      expect(isBacklogComplete([])).toBe(false);
    });

    it('returns true if all core items are done (mixed tier)', () => {
      const items = [
        createItem('1', 'core', 'done'),
        createItem('2', 'ornamental', 'pending'), // should be ignored
      ];
      expect(isBacklogComplete(items)).toBe(true);
    });

    it('returns false if any core item is pending', () => {
      const items = [
        createItem('1', 'core', 'done'),
        createItem('2', 'core', 'in_progress'),
      ];
      expect(isBacklogComplete(items)).toBe(false);
    });

    it('does not treat needs_review as successful completion', () => {
      const items = [
        createItem('1', 'ornamental', 'done'),
        createItem('2', 'ornamental', 'needs_review'),
      ];
      expect(isBacklogComplete(items)).toBe(false);
    });

    it('does not treat a core review item as successfully complete', () => {
      expect(isBacklogComplete([
        createItem('1', 'core', 'needs_review'),
      ])).toBe(false);
    });

    it('returns false if any ornamental item is pending and there are no core items', () => {
      const items = [
        createItem('1', 'ornamental', 'done'),
        createItem('2', 'ornamental', 'pending'),
      ];
      expect(isBacklogComplete(items)).toBe(false);
    });
  });

  describe('outstandingGatingItems', () => {
    it('returns pending core items', () => {
      const items = [
        createItem('1', 'core', 'pending'),
        createItem('2', 'core', 'rejected'), // rejected is excluded
        createItem('3', 'core', 'done'),
        createItem('4', 'ornamental', 'pending'),
      ];
      const out = outstandingGatingItems(items);
      expect(out.length).toBe(1);
      expect(out[0].id).toBe('1');
    });

    it('returns pending ornamental items when no core items exist', () => {
      const items = [
        createItem('1', 'ornamental', 'pending'),
        createItem('2', 'ornamental', 'done'),
        createItem('3', 'ornamental', 'in_progress'),
      ];
      const out = outstandingGatingItems(items);
      expect(out.length).toBe(2);
      expect(out.map(i => i.id)).toEqual(['1', '3']);
    });
  });

  describe('hasOutstandingWork', () => {
    it('returns true if any item (core or ornamental) is pending', () => {
      const items = [
        createItem('1', 'core', 'done'),
        createItem('2', 'ornamental', 'pending'), // triggers true for reopen
      ];
      expect(hasOutstandingWork(items)).toBe(true);
    });

    it('returns false if all items are terminal or rejected', () => {
      const items = [
        createItem('1', 'core', 'done'),
        createItem('2', 'ornamental', 'needs_review'),
        createItem('3', 'ornamental', 'rejected'),
      ];
      expect(hasOutstandingWork(items)).toBe(false);
    });
  });

  describe('isOrnamentalOnlyOutstanding', () => {
    it('returns false if there is outstanding core work', () => {
      const items = [
        createItem('1', 'core', 'pending'),
        createItem('2', 'ornamental', 'pending'),
      ];
      expect(isOrnamentalOnlyOutstanding(items)).toBe(false);
    });

    it('returns true if there is outstanding work but no outstanding core work', () => {
      const items = [
        createItem('1', 'core', 'done'),
        createItem('2', 'ornamental', 'pending'),
      ];
      expect(isOrnamentalOnlyOutstanding(items)).toBe(true);
    });

    it('returns false if there is no outstanding work at all', () => {
      const items = [
        createItem('1', 'core', 'done'),
        createItem('2', 'ornamental', 'done'),
      ];
      expect(isOrnamentalOnlyOutstanding(items)).toBe(false);
    });
  });

  describe('hasApprovedJudgeEvidence', () => {
    it('only accepts an explicit approved verdict', () => {
      expect(hasApprovedJudgeEvidence({
        evidence: { judge_verdict: 'approved' } as any,
      })).toBe(true);
      expect(hasApprovedJudgeEvidence({
        evidence: { judge_verdict: 'rejected' } as any,
      })).toBe(false);
      expect(hasApprovedJudgeEvidence({ evidence: undefined })).toBe(false);
    });
  });

  describe('pendingInPhase', () => {
    it('returns only items whose dependencies and blockers are clear', () => {
      const done = createItem('done', 'core', 'done');
      const runnable = {
        ...createItem('runnable', 'core', 'pending'),
        depends_on: ['done'],
      };
      const dependencyBlocked = {
        ...createItem('dependency-blocked', 'core', 'pending'),
        depends_on: ['unfinished'],
      };
      const explicitlyBlocked = {
        ...createItem('explicitly-blocked', 'core', 'pending'),
        blocked_by: [{
          blocker_id: 'preview',
          category: 'missing_precondition' as const,
          reason: 'Preview URL unavailable.',
          resolution_actor: 'platform' as const,
        }],
      };

      expect(pendingInPhase({
        schema_version: 1,
        items: [
          done,
          runnable,
          dependencyBlocked,
          explicitlyBlocked,
          createItem('unfinished', 'core', 'pending'),
        ],
        current_phase_id: 'phase1',
        completion_ratio: 0,
        cycles_spent_total: 0,
      }, 'phase1').map((item) => item.id)).toEqual([
        'runnable',
        'unfinished',
      ]);
    });

    it('skips quarantined review work and continues with pending items', () => {
      expect(pendingInPhase({
        schema_version: 1,
        items: [
          createItem('review', 'core', 'needs_review'),
          createItem('next', 'core', 'pending'),
        ],
        current_phase_id: 'phase1',
        completion_ratio: 0,
        cycles_spent_total: 0,
      }, 'phase1').map((item) => item.id)).toEqual(['next']);
    });
  });
});
