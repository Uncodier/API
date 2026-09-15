import { OpenAIToolSet } from 'composio-core';
import { ComposioTools } from '../composioTools';

jest.mock('composio-core', () => ({
  OpenAIToolSet: jest.fn(),
}));

const OpenAIToolSetMock = OpenAIToolSet as unknown as jest.Mock;

describe('ComposioTools', () => {
  const getTools = jest.fn();
  const executeAction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    OpenAIToolSetMock.mockImplementation(() => ({
      getTools,
      executeAction,
    }));
  });

  it('initializes Composio with the site API key and entity', async () => {
    getTools.mockResolvedValue([]);
    const tools = new ComposioTools({
      apiKey: 'site-composio-key',
      entityId: 'site-123',
    });

    await tools.getTools({ useCase: 'send an email' });

    expect(OpenAIToolSetMock).toHaveBeenCalledWith({
      apiKey: 'site-composio-key',
      entityId: 'site-123',
    });
  });

  it('executes actions with the configured site entity', async () => {
    executeAction.mockResolvedValue({
      successful: true,
      data: { id: 'message-123' },
    });
    const tools = new ComposioTools({
      apiKey: 'site-composio-key',
      entityId: 'site-123',
    });

    await expect(
      tools.executeAction('SLACK_SEND_MESSAGE', { channel: 'general' })
    ).resolves.toEqual({ id: 'message-123' });
    expect(executeAction).toHaveBeenCalledWith({
      action: 'SLACK_SEND_MESSAGE',
      params: { channel: 'general' },
      entityId: 'site-123',
    });
  });
});
