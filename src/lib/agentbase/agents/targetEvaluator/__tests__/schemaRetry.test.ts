import { TargetProcessor } from '../../TargetProcessor';
import { schemaRetryUserMessage } from '../schemaRetry';

jest.mock('../validateResults.js', () => ({
  validateResults: (results: any) => ({
    isValid: Array.isArray(results) && results.length > 0,
  }),
}));

jest.mock('../../../services/command/CommandCache', () => ({
  CommandCache: {
    getCachedCommand: jest.fn(() => null),
    cacheCommand: jest.fn(),
  },
}));

jest.mock('../../../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    verifyAgentBackground: jest.fn(),
  },
}));

describe('TargetProcessor schema retry', () => {
  const targets = [{ message: { text: '' } }];

  function commandFixture() {
    return {
      id: 'cmd-schema',
      agent_background: 'You are a customer support agent with enough context.',
      context: 'Need a follow-up',
      targets,
      status: 'running',
    } as any;
  }

  it('re-prompts with the schema error when JSON is valid but target keys are wrong', async () => {
    const callAgent = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify([{ wrong_key: 'hello' }]) })
      .mockResolvedValueOnce({ content: JSON.stringify([{ message: { text: 'fixed' } }]) });

    const processor = new TargetProcessor('tp', 'target', { callAgent } as any);
    const result = await processor.executeCommand(commandFixture());

    expect(callAgent).toHaveBeenCalledTimes(2);
    const retryMessage = callAgent.mock.calls[1][0].find((m: any) => m.role === 'user' && String(m.content).includes('wrong_key'));
    expect(retryMessage.content).toContain(schemaRetryUserMessage('').split('\n')[0]);
    expect(retryMessage.content).toContain('missing target keys');
    expect(result.status).toBe('completed');
    expect(result.results?.[0]?.message?.text).toBe('fixed');
  });

  it('fails with the validation error when the second attempt is still invalid', async () => {
    const callAgent = jest.fn().mockResolvedValue({
      content: JSON.stringify([{ wrong_key: 'still bad' }]),
    });

    const processor = new TargetProcessor('tp', 'target', { callAgent } as any);
    const result = await processor.executeCommand(commandFixture());

    expect(callAgent).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('missing target keys');
  });
});
