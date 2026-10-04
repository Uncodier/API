import { randomBytes, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { batchCreateResponseNodes, fetchNodeContexts, updateNodeResult, failNode } from '@/lib/services/robot-instance/assistant-logging';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/robot-instance/assistant-logging', () => ({
  batchCreateResponseNodes: jest.fn(), fetchNodeContexts: jest.fn(), updateNodeResult: jest.fn(), failNode: jest.fn(),
}));
const mockCreate = jest.fn();
const request = () => new NextRequest('https://example.invalid/api/workflow/execute-node', {
  method: 'POST', body: JSON.stringify({ instance_node_id: randomUUID() }),
});

describe('workflow OpenRouter streaming accounting', () => {
  const env = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = randomBytes(24).toString('hex');
    delete process.env.OPENROUTER_CHAT_MODEL;
    jest.mocked(OpenAI).mockImplementation(() => ({ chat: { completions: { create: mockCreate } } }) as any);
    const query = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { settings: {} } }) };
    jest.mocked(supabaseAdmin.from).mockReturnValue(query as any);
    jest.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: [] } as any);
    jest.mocked(batchCreateResponseNodes).mockResolvedValue(['response-node']);
    jest.mocked(fetchNodeContexts).mockResolvedValue([]);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { process.env = { ...env }; jest.restoreAllMocks(); });

  it('stores usage.cost and generation ID from the final empty-choices frame', async () => {
    const id = randomUUID();
    const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.015 };
    mockCreate.mockResolvedValueOnce((async function* () {
      yield { id, model: 'openai/gpt-6.1-sol', provider: 'upstream', choices: [{ delta: { content: 'answer' } }] };
      yield { id, choices: [], usage };
    })());
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(updateNodeResult).toHaveBeenLastCalledWith('response-node', {
      text: 'answer', status: 'done', gateway: 'openrouter', model: 'openai/gpt-6.1-sol',
      id, generation_id: id, provider: 'upstream', usage,
    });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream_options: { include_usage: true } }));
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('marks an upstream failure without persisting credential-bearing errors', async () => {
    const credential = randomBytes(24).toString('hex');
    mockCreate.mockRejectedValueOnce(new Error(`Authorization: Bearer ${credential}`));
    const response = await POST(request());
    expect(await response.text()).not.toContain(credential);
    expect(failNode).toHaveBeenCalledWith('response-node', 'OpenRouter generation failed');
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(credential);
  });
});