const mockCreateAssistant = jest.fn();
const mockCreateCall = jest.fn();

jest.mock('@vapi-ai/server-sdk', () => ({
  VapiClient: jest.fn().mockImplementation(() => ({
    assistants: { create: mockCreateAssistant },
    calls: { create: mockCreateCall },
  })),
}));

import { VapiService } from '../vapi-service';

describe('VapiService assistant identifiers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateCall.mockResolvedValue({ id: 'call-id', status: 'queued' });
  });

  it.each([
    { id: 'rest-assistant-id' },
    { type: 'assistant', assistantId: 'sdk-assistant-id', name: 'Coordinator' },
  ])('uses an assistant ID from either response shape: %j', async (assistant) => {
    mockCreateAssistant.mockResolvedValue(assistant);
    const result = await VapiService.initiateCall(
      '+15555550100',
      { title: 'Planning', objective: 'Agree next steps' },
      'Coordinate the meeting',
    );

    expect(mockCreateAssistant).toHaveBeenCalledWith(expect.objectContaining({
      serverMessages: [],
    }));
    expect(mockCreateCall).toHaveBeenCalledWith(expect.objectContaining({
      assistant: { id: assistant.id ?? assistant.assistantId },
    }));
    expect(result).toEqual({ id: 'call-id', status: 'queued', phone_number: '+15555550100' });
  });

  it('does not initiate a call when the response has no assistant ID', async () => {
    mockCreateAssistant.mockResolvedValue({ name: 'Coordinator' });
    const result = await VapiService.initiateCall(
      '+15555550100',
      { title: 'Planning', objective: 'Agree next steps' },
      'Coordinate the meeting',
    );

    expect(result.status).toBe('failed');
    expect(mockCreateCall).not.toHaveBeenCalled();
  });
});