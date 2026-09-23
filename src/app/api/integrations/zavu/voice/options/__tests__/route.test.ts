const mockRequireZavuSiteAccess = jest.fn();
const mockListAgentVoices = jest.fn();
const mockGetVoicePreferences = jest.fn();

jest.mock("@/lib/services/zavu", () => ({
  requireZavuSiteAccess: mockRequireZavuSiteAccess,
  listAgentVoices: mockListAgentVoices,
  getCustomerSupportVoicePreferences: mockGetVoicePreferences,
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

const SITE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("Zavu Voice options", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireZavuSiteAccess.mockResolvedValue("admin");
    mockListAgentVoices.mockResolvedValue({
      items: [{ id: "voice-es", name: "Celeste", language: "es" }],
      languages: ["auto", "es"],
      total: 1,
    });
    mockGetVoicePreferences.mockResolvedValue({
      language: "es",
      ttsVoiceId: "voice-es",
    });
  });

  it("authorizes the site and returns the provider catalog", async () => {
    const response = await GET(new NextRequest(
      `https://backend.example.com/api/integrations/zavu/voice/options?siteId=${SITE_ID}&language=es`
    ));

    expect(response.status).toBe(200);
    expect(mockRequireZavuSiteAccess).toHaveBeenCalledWith(
      expect.any(NextRequest),
      SITE_ID
    );
    expect(mockListAgentVoices).toHaveBeenCalledWith("es");
    await expect(response.json()).resolves.toMatchObject({
      items: [{ id: "voice-es" }],
      languages: ["auto", "es"],
      preferences: {
        language: "es",
        ttsVoiceId: "voice-es",
      },
    });
  });

  it("rejects invalid language filters before calling Zavu", async () => {
    const response = await GET(new NextRequest(
      `https://backend.example.com/api/integrations/zavu/voice/options?siteId=${SITE_ID}&language=not_a_language`
    ));

    expect(response.status).toBe(400);
    expect(mockListAgentVoices).not.toHaveBeenCalled();
  });
});
