jest.mock('../agent-client', () => ({ getSenderAgent: jest.fn(), listAgentTools: jest.fn(), updateAgent: jest.fn() }));
import { getSenderAgent, listAgentTools, updateAgent } from '../agent-client';
import { requireVoiceExecutionContextSupport } from '../voice-agent-context';

describe('instruction-only call context capability gate', () => {
  beforeEach(() => jest.resetAllMocks());
  it('accepts only a synchronized runtime and enabled context tool', async () => {
    jest.mocked(getSenderAgent).mockResolvedValue({ id: 'agent', systemPrompt: 'First silently call get_call_context for direction and purpose.' } as any);
    jest.mocked(listAgentTools).mockResolvedValue([{ name: 'get_call_context', enabled: true }] as any);
    await expect(requireVoiceExecutionContextSupport('sender')).resolves.toBeUndefined();
    expect(updateAgent).not.toHaveBeenCalled();
  });
  it.each([
    { prompt: 'Legacy prompt', tools: [{ name: 'get_call_context', enabled: true }] },
    { prompt: 'First silently call get_call_context', tools: [] },
    { prompt: 'First silently call get_call_context', tools: [{ name: 'get_call_context', enabled: false }] },
  ])('fails before dialing with stale capability %p', async ({ prompt, tools }) => {
    jest.mocked(getSenderAgent).mockResolvedValue({ id: 'agent', systemPrompt: prompt } as any);
    jest.mocked(listAgentTools).mockResolvedValue(tools as any);
    await expect(requireVoiceExecutionContextSupport('sender')).rejects.toMatchObject({ status: 409 });
    expect(updateAgent).not.toHaveBeenCalled();
  });
});