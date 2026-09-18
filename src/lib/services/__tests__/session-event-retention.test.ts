import { describe, expect, it } from '@jest/globals';
import {
  getRecordingPaths,
  selectProtectedSiteIds,
} from '../session-event-retention';

describe('session event retention helpers', () => {
  it('protects sites whose latest billing plan is foundry or reactor', () => {
    const rows = [
      {
        id: 'billing-new',
        site_id: 'site-a',
        plan: 'free',
        updated_at: '2026-09-17T00:00:00.000Z',
      },
      {
        id: 'billing-reactor',
        site_id: 'site-b',
        plan: 'Reactor',
        updated_at: '2026-09-16T00:00:00.000Z',
      },
      {
        id: 'billing-old',
        site_id: 'site-a',
        plan: 'foundry',
        updated_at: '2026-09-15T00:00:00.000Z',
      },
      {
        id: 'billing-foundry',
        site_id: 'site-c',
        plan: ' foundry ',
        updated_at: '2026-09-14T00:00:00.000Z',
      },
    ];

    expect(selectProtectedSiteIds(rows)).toEqual(['site-b', 'site-c']);
  });

  it('extracts only valid recording object paths', () => {
    expect(getRecordingPaths({
      chunks: ['site/session/one.json', null, '', 42, 'site/session/two.json'],
    })).toEqual(['site/session/one.json', 'site/session/two.json']);
    expect(getRecordingPaths(null)).toEqual([]);
    expect(getRecordingPaths({ chunks: 'not-an-array' })).toEqual([]);
  });
});
