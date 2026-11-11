import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { formatLeadRecordForContext, loadLeadRecordSnapshot, type LeadRecordSnapshot } from '../lead-record';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { schema: jest.fn() },
}));

describe('formatLeadRecordForContext', () => {
  it('tells the agent to look up tools when the snapshot is empty', () => {
    const empty: LeadRecordSnapshot = {
      appointments: [],
      reservations: [],
      meetingTasks: [],
      orders: [],
    };

    const text = formatLeadRecordForContext(empty, 'America/Mexico_City');

    expect(text).toContain('=== LEAD RECORD (source of truth) ===');
    expect(text).toContain('No active appointments');
    expect(text).toContain('Still look them up with tools');
  });

  it('lists existing appointments so a later turn cannot miss the 11:00 booking', () => {
    const snapshot: LeadRecordSnapshot = {
      appointments: [
        {
          id: 'appt-11',
          title: 'Mauricio',
          start_datetime: '2026-08-26T17:00:00.000Z',
          end_datetime: '2026-08-26T18:00:00.000Z',
          status: 'confirmed',
          timezone: 'America/Mexico_City',
        },
      ],
      reservations: [],
      meetingTasks: [],
      orders: [{ id: 'ord-1', title: 'Order - 2026-08-26', status: 'pending', amount: 500, currency: 'MXN' }],
    };

    const text = formatLeadRecordForContext(snapshot, 'America/Mexico_City');

    expect(text).toContain('id=appt-11');
    expect(text).toContain('Mauricio');
    expect(text).toContain('2026-08-26 11:00 America/Mexico_City');
    expect(text).toContain('start_utc=2026-08-26T17:00:00.000Z');
    expect(text).toContain('id=ord-1');
    expect(text).toContain('reschedule/update that record');
    expect(text).not.toContain('No active appointments');
  });

  it('keeps legacy meetingTasks snapshots readable', () => {
    const text = formatLeadRecordForContext({
      appointments: [], reservations: [], orders: [],
      meetingTasks: [{ id: 'meeting-1', title: 'Existing meeting', status: 'pending' }],
    });
    expect(text).toContain('Meeting tasks:');
    expect(text).toContain('id=meeting-1');
  });

  it('shows non-meeting tasks with original information for subsequent turns', () => {
    const text = formatLeadRecordForContext({
      appointments: [], reservations: [], orders: [], meetingTasks: [],
      openTasks: [{ id: 'task-1', title: 'Review study results', type: 'support', status: 'in_progress',
        description: 'Study 42: send results after review', notes: 'Call after 5 PM',
        assignee: 'teammate-1' }],
      openTasksComplete: true,
    });
    expect(text).toContain('Open tasks:');
    for (const value of ['task-1', 'Review study results', 'in_progress', 'Study 42: send results after review',
      'Call after 5 PM', 'teammate-1', 'GET_TASKS', 'UPDATE_TASK']) {
      expect(text).toContain(value);
    }
    expect(text).not.toContain('No active appointments');
  });
});

describe('loadLeadRecordSnapshot open tasks', () => {
  const leadId = randomUUID();
  const siteId = randomUUID();
  let taskQueries: any[];
  let taskPages: Array<{ data: unknown; error: unknown }>;

  beforeEach(() => {
    taskQueries = [];
    taskPages = [{ data: [], error: null }];
    (supabaseAdmin.schema as jest.Mock).mockImplementation(() => ({
      from: (table: string) => {
        const query: any = {};
        for (const method of ['select', 'eq', 'not', 'in', 'order', 'limit', 'range']) {
          query[method] = jest.fn(() => query);
        }
        const result = table === 'tasks' ? taskPages.shift() : { data: [], error: null };
        query.then = (resolve: (value: unknown) => void) => Promise.resolve(result).then(resolve);
        if (table === 'tasks') taskQueries.push(query);
        return query;
      },
    }));
  });

  it('loads all open types and paginates with site/lead scope, not user or title filters', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `task-${index}`, type: index === 0 ? 'meeting' : 'support', status: 'pending',
    }));
    const secondPage = [{ id: 'last-task', type: 'call', status: 'in_progress', notes: 'Keep this commitment' }];
    taskPages = [{ data: firstPage, error: null }, { data: secondPage, error: null }];
    const snapshot = await loadLeadRecordSnapshot(leadId, siteId);
    expect(snapshot.openTasks).toEqual([...firstPage, ...secondPage]);
    expect(snapshot.meetingTasks).toEqual([firstPage[0]]);
    expect(snapshot.openTasksComplete).toBe(true);
    expect(taskQueries).toHaveLength(2);
    taskQueries.forEach((query, index) => {
      expect(query.eq.mock.calls).toEqual([['lead_id', leadId], ['site_id', siteId]]);
      expect(query.in).toHaveBeenCalledWith('status', ['pending', 'in_progress']);
      expect(query.order).toHaveBeenCalledWith('id', { ascending: true });
      expect(query.range).toHaveBeenCalledWith(index * 100, index * 100 + 99);
      expect(query.limit).not.toHaveBeenCalled();
    });
  });

  it.each([0, 1])('does not disguise a failed page %s as a verified empty list', async failedPage => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      taskPages = [
        ...(failedPage ? [{ data: Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}` })), error: null }] : []),
        { data: null, error: { message: 'Lookup unavailable' } },
      ];
      const snapshot = await loadLeadRecordSnapshot(leadId, siteId);
      expect(snapshot.openTasksComplete).toBe(false);
      const text = formatLeadRecordForContext(snapshot);
      expect(text).toContain('Open task lookup unavailable or incomplete');
      expect(text).toContain('do NOT CREATE_TASK until a full live lookup succeeds');
    } finally {
      log.mockRestore();
    }
  });

  it('bounds the snapshot and requires live pagination when the snapshot is truncated', async () => {
    taskPages = Array.from({ length: 3 }, (_, page) => ({
      data: Array.from({ length: 100 }, (_, i) => ({ id: `task-${page}-${i}`, type: 'support', status: 'pending' })),
      error: null,
    }));
    const snapshot = await loadLeadRecordSnapshot(leadId, siteId);
    expect(snapshot.openTasks).toHaveLength(200);
    expect(snapshot.openTasksComplete).toBe(false);
    expect(taskQueries).toHaveLength(2);
    expect(formatLeadRecordForContext(snapshot)).toContain('do NOT CREATE_TASK until a full live lookup succeeds');
  });
});
