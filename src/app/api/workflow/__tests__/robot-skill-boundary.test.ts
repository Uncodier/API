import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const getInstance = jest.fn();
const from = jest.fn();
jest.unstable_mockModule('@/lib/services/workflow-service', () => ({ WorkflowService: { getInstance } }));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));

let startRobot: typeof import('../startRobot/route').POST;
let promptRobot: typeof import('../promptRobot/route').POST;

beforeAll(async () => {
  ({ POST: startRobot } = await import('../startRobot/route'));
  ({ POST: promptRobot } = await import('../promptRobot/route'));
});

function request(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/workflow/${path}`, {
    method: 'POST', body: JSON.stringify(body),
  });
}

describe('Temporal robot skill boundary', () => {
  const start = jest.fn<(args: Record<string, unknown>, options: Record<string, unknown>) => Promise<any>>();
  const prompt = jest.fn<(args: Record<string, unknown>, options: Record<string, unknown>) => Promise<any>>();

  beforeEach(() => {
    jest.clearAllMocks();
    getInstance.mockReturnValue({ startRobot: start, promptRobot: prompt });
    start.mockResolvedValue({ success: true, data: { status: 'started' } });
    prompt.mockResolvedValue({ success: true, data: { status: 'prompted' } });
    from.mockReturnValue({
      select: () => ({ eq: () => ({ single: async () => ({ data: { site_id: 'site-a' }, error: null }) }) }),
    });
  });

  it('does not forward skills to Temporal when starting a robot', async () => {
    const response = await startRobot(request('startRobot', {
      site_id: 'site-a', activity: 'robot', message: 'hello', skill_mode: 'auto', skill_slugs: [],
    }));
    expect(response.status).toBe(200);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: 'site-a', activity: 'robot' }), expect.anything(),
    );
    expect(start.mock.calls[0][0]).not.toHaveProperty('skill_mode');
    expect(start.mock.calls[0][0]).not.toHaveProperty('skill_slugs');
  });

  it('does not forward skills to Temporal when prompting an existing robot', async () => {
    const response = await promptRobot(request('promptRobot', {
      instance_id: 'instance-a', site_id: 'site-a', message: 'hello', step_status: 'in_progress',
      context: '{}', activity: 'robot', skill_mode: 'auto', skill_slugs: [],
    }));
    expect(response.status).toBe(200);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: 'instance-a', message: 'hello' }), expect.anything(),
    );
    expect(prompt.mock.calls[0][0]).not.toHaveProperty('skill_mode');
    expect(prompt.mock.calls[0][0]).not.toHaveProperty('skill_slugs');
  });

  it('accepts new skill-free requests without adding selection fields', async () => {
    const startResponse = await startRobot(request('startRobot', {
      site_id: 'site-a', activity: 'robot', message: 'hello',
    }));
    const promptResponse = await promptRobot(request('promptRobot', {
      instance_id: 'instance-a', site_id: 'site-a', message: 'hello', step_status: 'in_progress',
      context: '{}', activity: 'robot',
    }));
    expect(startResponse.status).toBe(200);
    expect(promptResponse.status).toBe(200);
    expect(start.mock.calls[0][0]).not.toHaveProperty('skill_slugs');
    expect(prompt.mock.calls[0][0]).not.toHaveProperty('skill_mode');
  });

  it.each(['startRobot', 'promptRobot'])(
    'rejects old %s requests that try to attach skills before workflow dispatch', async path => {
      const body = path === 'startRobot'
        ? { site_id: 'site-a', activity: 'robot' }
        : { site_id: 'site-a', instance_id: 'instance-a', message: 'hello',
          step_status: 'in_progress', context: '{}', activity: 'robot' };
      for (const selection of [
        { skill_mode: 'required', skill_slugs: ['writer'] },
        { skill_mode: 'required', skill_slugs: [] },
        { skill_mode: 'auto', skill_slugs: ['writer'] },
        { skill_mode: 'unexpected' },
        { skill_slugs: 'writer' },
      ]) {
        const response = await (path === 'startRobot' ? startRobot : promptRobot)(
          request(path, { ...body, ...selection }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual(expect.objectContaining({
          error: expect.objectContaining({ code: 'INVALID_SKILL_SELECTION' }),
        }));
      }
      expect(getInstance).not.toHaveBeenCalled();
    },
  );

  it('keeps the existing instance-site ownership check', async () => {
    const response = await promptRobot(request('promptRobot', {
      instance_id: 'instance-a', site_id: 'site-b', message: 'hello', step_status: 'in_progress',
      context: '{}', activity: 'robot',
    }));
    expect(response.status).toBe(400);
    expect(getInstance).not.toHaveBeenCalled();
  });
});