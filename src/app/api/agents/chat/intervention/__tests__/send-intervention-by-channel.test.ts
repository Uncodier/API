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
      greeting: "Hello, I am following up about your appointment.",
      messageId: "message-1",
      conversationId: "conversation-1",
      leadId: "lead-1",
      objective:
        "Continue the customer conversation after the team-authored opening message and resolve the remaining request.",
      additionalContext:
        "This follow-up was initiated by a Makinari team member. Use the private follow-up snapshot for continuity.",
      includeCurrentMessageInFollowUp: true,
    });
    expect(result).toMatchObject({
      success: true,
      method: "voice_agent_call",
      callId: "call-1",
      workflowStarted: false,
    });
  });
});
