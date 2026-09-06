import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import {
  groupOldestPendingByInstance,
  isInstanceIdleFromLogs,
  processPendingWorkTick,
  sendPendingWorkNow,
} from '../pending-work';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('workflow/api', () => ({
  start: jest.fn(),
}));

jest.mock('@/app/api/robots/instance/assistant/workflow', () => ({
  runAssistantWorkflow: jest.fn(),
}));

jest.mock('@/app/api/robots/instance/assistant/user-message-log', () => ({
  insertUserActionLog: jest.fn().mockResolvedValue({ id: 'log-1' }),
  withRetries: (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('@/lib/services/requirement-cron-reset', () => ({
  resetRequirementOnUserAction: jest.fn().mockResolvedValue(undefined),
}));

function createChain(result: { data?: any; error?: any } = { data: null, error: null }) {
  const chain: any = {};
  const self = () => chain;
  chain.select = jest.fn(self);
  chain.eq = jest.fn(self);
  chain.in = jest.fn(self);
  chain.order = jest.fn(self);
  chain.limit = jest.fn().mockResolvedValue(result);
  chain.update = jest.fn(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  chain.single = jest.fn().mockResolvedValue(result);
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const pendingRow = {
  id: 'pending-1',
  instance_id: 'inst-1',
  site_id: 'site-1',
  user_id: 'user-1',
  message: 'do this next',
  activity: 'ask',
  context: { mediaType: 'text' },
  system_prompt: 'answer',
  status: 'pending',
};

describe('pending work helpers', () => {
  it('treats a running user_action as busy', () => {
    expect(isInstanceIdleFromLogs([
      { log_type: 'user_action', details: { status: 'running' } },
    ])).toBe(false);
    expect(isInstanceIdleFromLogs([
      { log_type: 'user_action', details: { status: 'stopped' } },
    ])).toBe(true);
  });

  it('keeps the oldest pending row per instance', () => {
    const rows = [
      { ...pendingRow, id: 'a', instance_id: 'inst-1' },
      { ...pendingRow, id: 'b', instance_id: 'inst-1' },
      { ...pendingRow, id: 'c', instance_id: 'inst-2' },
    ];
    expect(groupOldestPendingByInstance(rows).map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('prefers an in-flight claimed row over a newer pending one', () => {
    const rows = [
      { ...pendingRow, id: 'pending-new', instance_id: 'inst-1', status: 'pending' as const },
      { ...pendingRow, id: 'claimed-old', instance_id: 'inst-1', status: 'claimed' as const },
    ];
    expect(groupOldestPendingByInstance(rows).map((row) => row.id)).toEqual(['claimed-old']);
  });
});

describe('processPendingWorkTick', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips busy instances without claiming or starting', async () => {
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(createChain({ data: [pendingRow], error: null }))
      .mockReturnValueOnce(createChain({
        data: [{ log_type: 'user_action', details: { status: 'running' } }],
        error: null,
      }));

    const results = await processPendingWorkTick();

    expect(results).toEqual([{ instance_id: 'inst-1', status: 'busy' }]);
    expect(start).not.toHaveBeenCalled();
  });

  it('claims and starts the oldest pending row when idle', async () => {
    const claimed = { ...pendingRow, status: 'claimed' };
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(createChain({ data: [pendingRow], error: null }))
      .mockReturnValueOnce(createChain({ data: [], error: null }))
      .mockReturnValueOnce(createChain({ data: claimed, error: null }))
      .mockReturnValueOnce(createChain({
        data: { site_id: 'site-1', user_id: 'user-1', status: 'running' },
        error: null,
      }))
      .mockReturnValueOnce(createChain({ error: null }));

    (start as jest.Mock).mockResolvedValue({ runId: 'run-1' });

    const results = await processPendingWorkTick();

    expect(results).toEqual([{ instance_id: 'inst-1', status: 'sent' }]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['inst-1', 'do this next', 'site-1', 'user-1'])
    );
  });
});

describe('sendPendingWorkNow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('cancels the running workflow, claims the selected pending row, and starts', async () => {
    const claimed = { ...pendingRow, status: 'claimed' };
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(createChain({
        data: [{ id: 'run-log', details: { status: 'running' } }],
        error: null,
      }))
      .mockReturnValueOnce(createChain({ error: null }))
      .mockReturnValueOnce(createChain({ error: null }))
      .mockReturnValueOnce(createChain({ data: [], error: null }))
      .mockReturnValueOnce(createChain({ data: claimed, error: null }))
      .mockReturnValueOnce(createChain({
        data: { site_id: 'site-1', user_id: 'user-1', status: 'running' },
        error: null,
      }))
      .mockReturnValueOnce(createChain({ error: null }));

    (start as jest.Mock).mockResolvedValue({ runId: 'run-1' });

    const result = await sendPendingWorkNow({
      pendingId: 'pending-1',
      instanceId: 'inst-1',
    });

    expect(result).toEqual({ cancelledLogId: 'run-log', pendingId: 'pending-1' });
    expect(start).toHaveBeenCalledTimes(1);
  });
});
