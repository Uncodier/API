const mockPlaceTrackedVoiceCall = jest.fn();

jest.mock("@/lib/database/supabase-client", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/lib/services/workflow-service", () => ({
  WorkflowService: { getInstance: jest.fn() },
}));
jest.mock("@/lib/services/channels/ChannelSendService", () => ({
  sanitizeZavuRecipient: (value: string) => value.replace(/^\+/, ""),
}));
jest.mock("@/lib/services/zavu/voice-call-service", () => ({
  placeTrackedVoiceCall: mockPlaceTrackedVoiceCall,
}));

import { sendMessageByChannel } from "../send-intervention-by-channel";
import { VoicePlacementError } from '@/lib/services/zavu/voice-call-message-state';

describe("Voice human intervention", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlaceTrackedVoiceCall.mockResolvedValue({
      deliveryId: "delivery-1",
      duplicate: false,
      call: { id: "call-1", status: "queued" },
    });
  });

  it("starts a contextual two-way agent call instead of a TTS message", async () => {
    const result = await sendMessageByChannel(
      "voice",
      "Hello, I am following up about your appointment.",
      {
        leadId: "lead-1",
        leadPhone: "+14155550100",
        channelDelivery: true,
      },
      "site-1",
      "agent-1",
      "conversation-1",
      undefined,
      "message-1"
    );

    expect(mockPlaceTrackedVoiceCall).toHaveBeenCalledWith({
      siteId: "site-1",
      to: "+14155550100",
      messageId: "message-1",
      conversationId: "conversation-1",
      leadId: "lead-1",
      objective:
        "Hello, I am following up about your appointment.",
      additionalContext:
        "Team-requested outbound follow-up. Verify appointment state before claiming it is confirmed. Team request: Hello, I am following up about your appointment.",
      executionContext: {
        version: 1, site_id: 'site-1', intent: 'Hello, I am following up about your appointment.',
        source: { tool: 'conversation_intervention', conversation_id: 'conversation-1', message_id: 'message-1' },
      },
      includeCurrentMessageInFollowUp: true,
    });
    expect(result).toMatchObject({
      success: true,
      method: "voice_agent_call",
      callId: "call-1",
      workflowStarted: false,
    });
  });

  it('keeps the actual operator intent private instead of speaking an instruction as the greeting', async () => {
    await sendMessageByChannel('voice', 'Llama para confirmar la cita del lunes a las cinco',
      { leadId: 'lead-1', leadPhone: '+14155550100' }, 'site-1', null, 'conversation-1', undefined, 'message-1');
    const call = mockPlaceTrackedVoiceCall.mock.calls[0][0];
    expect(call.objective).toBe('Llama para confirmar la cita del lunes a las cinco');
    expect(call.executionContext.intent).toBe(call.objective);
    expect(call).not.toHaveProperty('greeting');
    expect(call.additionalContext).toContain('Verify appointment state');
  });

  it('does not truncate operator text before the service redacts and budgets it', async () => {
    const instruction = `${'Please review the earlier request. '.repeat(20)}Do not confirm without checking availability.`;
    await sendMessageByChannel('voice', instruction, { leadId: 'lead-1', leadPhone: '+14155550100' },
      'site-1', null, 'conversation-1', undefined, 'message-1');
    expect(mockPlaceTrackedVoiceCall.mock.calls[0][0].objective).toBe(instruction);
    expect(mockPlaceTrackedVoiceCall.mock.calls[0][0].executionContext.intent).toBe(instruction);
  });

  it.each(['failed', 'placement_unknown'] as const)('propagates typed voice outcome %s without claiming a workflow failure', async (status) => {
    mockPlaceTrackedVoiceCall.mockRejectedValue(new VoicePlacementError(new Error('Placement rejected'), status));
    const result = await sendMessageByChannel('voice', 'Hello', { leadPhone: '+14155550100' }, 'site', null, 'conversation', 'lead', 'message');
    expect(result).toMatchObject({ success: false, method: 'voice_agent_call', delivery_status: status });
    expect(result.reason).not.toBe('workflow_start_failed');
  });

  it('lets the tracked service persist a missing-phone preflight failure', async () => {
    mockPlaceTrackedVoiceCall.mockRejectedValue(new VoicePlacementError(new Error('Missing phone'), 'failed'));
    const result = await sendMessageByChannel('voice', 'Hello', {}, 'site', null, 'conversation', 'lead', 'message');
    expect(mockPlaceTrackedVoiceCall).toHaveBeenCalledWith(expect.objectContaining({ to: '', messageId: 'message' }));
    expect(result.delivery_status).toBe('failed');
  });
});
