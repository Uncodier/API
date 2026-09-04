const createMock = jest.fn();

jest.mock('portkey-ai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: any[]) => createMock(...args),
      },
    },
  }));
});

jest.mock('../AIGatewayService', () => ({
  AIGatewayService: jest.fn().mockImplementation(() => ({
    isAvailable: () => false,
    callAgent: jest.fn(),
  })),
}));

import { PortkeyConnector } from '../PortkeyConnector';

describe('PortkeyConnector non-stream fallback', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('retries a no-stream 429 with gpt-4o', async () => {
    createMock
      .mockRejectedValueOnce({ status: 429, message: 'rate limit exceeded' })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'fallback-ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

    const connector = new PortkeyConnector({
      apiKey: 'pk-test',
      virtualKeys: { openai: 'vk-test' },
    });

    const result = await connector.callAgent(
      [
        { role: 'system', content: 'You are a support agent with enough context.' },
        { role: 'user', content: 'hi' },
      ],
      { modelType: 'openai', modelId: 'gpt-5.6-sol', stream: false }
    );

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[1][0].model).toBe('gpt-4o');
    expect(createMock.mock.calls[1][0].stream).toBe(false);
    expect(result.content).toBe('fallback-ok');
    expect(result.modelInfo.model).toBe('gpt-4o');
  });
});
