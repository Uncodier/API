const mockRequireZavuSiteManager = jest.fn();
const mockGetChannelConnection = jest.fn();
const mockGetCustomerSupportVoicePreferences = jest.fn();
const mockMergeVoiceAgentPreferences = jest.fn();
const mockListAgentVoices = jest.fn();
const mockValidateVoiceAgentPreferences = jest.fn();
const mockUpdateCustomerSupportVoicePreferences = jest.fn();
const mockUpdateAllVoiceConnectionPreferences = jest.fn();
const mockSyncConnectedCustomerSupportVoiceAgentDetailed = jest.fn();
const mockRollbackConnectedVoiceAgentSync = jest.fn();

jest.mock("@/lib/services/zavu", () => ({
  requireZavuSiteManager: mockRequireZavuSiteManager,
  getChannelConnection: mockGetChannelConnection,
  getCustomerSupportVoicePreferences: mockGetCustomerSupportVoicePreferences,
  mergeVoiceAgentPreferences: mockMergeVoiceAgentPreferences,
  listAgentVoices: mockListAgentVoices,
  validateVoiceAgentPreferences: mockValidateVoiceAgentPreferences,
  updateCustomerSupportVoicePreferences: mockUpdateCustomerSupportVoicePreferences,
  updateAllVoiceConnectionPreferences: mockUpdateAllVoiceConnectionPreferences,
  syncConnectedCustomerSupportVoiceAgentDetailed:
    mockSyncConnectedCustomerSupportVoiceAgentDetailed,
  rollbackConnectedVoiceAgentSync: mockRollbackConnectedVoiceAgentSync,
}));

import { NextRequest } from "next/server";
import { PATCH } from "../route";

const SITE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CHANNEL_ID = "11111111-2222-4333-8444-555555555555";

describe("Zavu Voice preference updates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireZavuSiteManager.mockResolvedValue(undefined);
    mockGetChannelConnection.mockResolvedValue({
      id: CHANNEL_ID,
      type: "voice",
      status: "connected",
    });
    mockGetCustomerSupportVoicePreferences.mockResolvedValue({
      language: "auto",
    });
    mockMergeVoiceAgentPreferences.mockReturnValue({
      language: "es",
      ttsVoiceId: "voice-es",
    });
    mockListAgentVoices.mockResolvedValue({
      items: [{ id: "voice-es", name: "Celeste", language: "es" }],
      languages: ["auto", "es"],
    });
    mockUpdateCustomerSupportVoicePreferences.mockResolvedValue({
      language: "es",
      ttsVoiceId: "voice-es",
    });
    mockUpdateAllVoiceConnectionPreferences.mockResolvedValue({
      connections: [{
        id: CHANNEL_ID,
        type: "voice",
        metadata: {
          voice_language: "es",
          tts_voice_id: "voice-es",
        },
      }],
    });
    mockSyncConnectedCustomerSupportVoiceAgentDetailed.mockResolvedValue({
      synced: true,
      newlyEnabledSenderIds: [],
      previousConnections: [],
    });
    mockRollbackConnectedVoiceAgentSync.mockResolvedValue(undefined);
  });

  it("persists validated settings and resynchronizes the connected agent", async () => {
    const response = await PATCH(new NextRequest(
      "https://backend.example.com/api/integrations/zavu/voice",
      {
        method: "PATCH",
        body: JSON.stringify({
          siteId: SITE_ID,
          channelId: CHANNEL_ID,
          language: "es",
          ttsVoiceId: "voice-es",
        }),
      }
    ));

    expect(response.status).toBe(200);
    expect(mockRequireZavuSiteManager).toHaveBeenCalled();
    expect(mockValidateVoiceAgentPreferences).toHaveBeenCalledWith(
      { language: "es", ttsVoiceId: "voice-es" },
      expect.objectContaining({ languages: ["auto", "es"] })
    );
    expect(mockUpdateCustomerSupportVoicePreferences).toHaveBeenCalledWith(
      SITE_ID,
      expect.objectContaining({
        language: "es",
        ttsVoiceId: "voice-es",
      })
    );
    expect(mockSyncConnectedCustomerSupportVoiceAgentDetailed).toHaveBeenCalledWith(
      SITE_ID,
      {
        voicePreferences: { language: "es", ttsVoiceId: "voice-es" },
      }
    );
    expect(
      mockSyncConnectedCustomerSupportVoiceAgentDetailed.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockUpdateCustomerSupportVoicePreferences.mock.invocationCallOrder[0]
    );
    expect(mockUpdateAllVoiceConnectionPreferences).toHaveBeenCalledWith(
      SITE_ID,
      { language: "es", ttsVoiceId: "voice-es" }
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      voiceLanguage: "es",
      ttsVoiceId: "voice-es",
    });
  });

  it("restores local and remote state when canonical persistence fails", async () => {
    mockUpdateAllVoiceConnectionPreferences
      .mockRejectedValueOnce(new Error("Settings write failed"))
      .mockResolvedValueOnce({ connections: [] });

    const response = await PATCH(new NextRequest(
      "https://backend.example.com/api/integrations/zavu/voice",
      {
        method: "PATCH",
        body: JSON.stringify({
          siteId: SITE_ID,
          channelId: CHANNEL_ID,
          language: "es",
        }),
      }
    ));

    expect(response.status).toBe(500);
    expect(mockRollbackConnectedVoiceAgentSync).toHaveBeenCalledWith(
      SITE_ID,
      expect.objectContaining({ synced: true })
    );
    expect(mockUpdateCustomerSupportVoicePreferences).toHaveBeenLastCalledWith(
      SITE_ID,
      { language: "auto" }
    );
    expect(mockUpdateAllVoiceConnectionPreferences).toHaveBeenLastCalledWith(
      SITE_ID,
      { language: "auto" }
    );
  });

  it("requires a channel id when changing Voice preferences", async () => {
    const response = await PATCH(new NextRequest(
      "https://backend.example.com/api/integrations/zavu/voice",
      {
        method: "PATCH",
        body: JSON.stringify({
          siteId: SITE_ID,
          language: "es",
        }),
      }
    ));

    expect(response.status).toBe(400);
    expect(mockRequireZavuSiteManager).not.toHaveBeenCalled();
  });
});
