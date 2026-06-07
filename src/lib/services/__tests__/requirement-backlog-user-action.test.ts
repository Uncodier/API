import { hasUserRequestedMoreWork } from '../requirement-backlog';
import { supabaseAdmin } from '@/lib/database/supabase-server';

jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('hasUserRequestedMoreWork', () => {
  let selectMock: jest.Mock;
  let eqMock: jest.Mock;
  let singleMock: jest.Mock;
  let limitMock: jest.Mock;
  let orderMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    singleMock = jest.fn();
    limitMock = jest.fn();
    orderMock = jest.fn().mockReturnValue({ limit: limitMock });
    eqMock = jest.fn().mockReturnValue({
      single: singleMock,
      eq: jest.fn().mockReturnValue({ order: orderMock }), // For instance_logs chain
    });
    
    // For requirement query, `.eq` returns `{ single }`
    // For instance_logs query, `.eq` returns `{ eq }` which returns `{ order }`
    // Let's implement a more flexible mock chain
    const createChain = () => {
      const chain: any = {};
      chain.select = jest.fn().mockReturnValue(chain);
      chain.eq = jest.fn().mockReturnValue(chain);
      chain.single = singleMock;
      chain.order = jest.fn().mockReturnValue(chain);
      chain.limit = limitMock;
      return chain;
    };

    const reqChain = createChain();
    const logsChain = createChain();

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'requirements') return reqChain;
      if (table === 'instance_logs') return logsChain;
      return createChain();
    });
  });

  it('returns false if runner_instance_id is missing', async () => {
    singleMock.mockResolvedValue({
      data: { metadata: {}, backlog: { items: [] } }
    });

    const result = await hasUserRequestedMoreWork('req-1');
    expect(result).toBe(false);
  });

  it('returns false if there is no user_action log', async () => {
    singleMock.mockResolvedValue({
      data: { 
        metadata: { runner_instance_id: 'inst-1' }, 
        backlog: { items: [] } 
      }
    });
    limitMock.mockResolvedValue({ data: [] });

    const result = await hasUserRequestedMoreWork('req-1');
    expect(result).toBe(false);
  });

  it('returns false if user_action is older than the last completed core item', async () => {
    singleMock.mockResolvedValue({
      data: { 
        metadata: { runner_instance_id: 'inst-1' }, 
        backlog: { 
          items: [
            { id: '1', tier: 'core', status: 'done', updated_at: '2026-06-06T10:00:00Z' }
          ] 
        } 
      }
    });
    // user_action is at 09:00, before item completion at 10:00
    limitMock.mockResolvedValue({ 
      data: [{ created_at: '2026-06-06T09:00:00Z' }] 
    });

    const result = await hasUserRequestedMoreWork('req-1');
    expect(result).toBe(false);
  });

  it('returns true if user_action is newer than the last completed core item', async () => {
    singleMock.mockResolvedValue({
      data: { 
        metadata: { runner_instance_id: 'inst-1' }, 
        backlog: { 
          items: [
            { id: '1', tier: 'core', status: 'done', updated_at: '2026-06-06T10:00:00Z' }
          ] 
        } 
      }
    });
    // user_action is at 11:00, after item completion at 10:00
    limitMock.mockResolvedValue({ 
      data: [{ created_at: '2026-06-06T11:00:00Z' }] 
    });

    const result = await hasUserRequestedMoreWork('req-1');
    expect(result).toBe(true);
  });

  it('ignores non-core items when finding the last completion time', async () => {
    singleMock.mockResolvedValue({
      data: { 
        metadata: { runner_instance_id: 'inst-1' }, 
        backlog: { 
          items: [
            { id: '1', tier: 'core', status: 'done', updated_at: '2026-06-06T10:00:00Z' },
            { id: '2', tier: 'ornamental', status: 'done', updated_at: '2026-06-06T12:00:00Z' }
          ] 
        } 
      }
    });
    // user_action is at 11:00. It's after the core item (10:00), but before the ornamental item (12:00).
    // since we only care about gating/core items, it should still return true.
    limitMock.mockResolvedValue({ 
      data: [{ created_at: '2026-06-06T11:00:00Z' }] 
    });

    const result = await hasUserRequestedMoreWork('req-1');
    expect(result).toBe(true);
  });
});
