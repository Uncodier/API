import {
  isItemTerminal,
  gatingItems,
  isBacklogComplete,
  outstandingGatingItems,
  hasOutstandingWork,
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

    it('returns true if all items are done and there are no core items', () => {
      const items = [
        createItem('1', 'ornamental', 'done'),
        createItem('2', 'ornamental', 'needs_review'),
      ];
      expect(isBacklogComplete(items)).toBe(true);
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
});
