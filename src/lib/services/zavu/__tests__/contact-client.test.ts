const mockZavuFetch = jest.fn();

jest.mock("../client", () => ({
  zavuFetch: mockZavuFetch,
}));

import {
  clearVoiceCallContactContext,
  setVoiceCallContactContext,
  VOICE_CONTEXT_METADATA_KEYS,
} from "../contact-client";

describe("Zavu Voice contact context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("replaces stale Voice guidance while preserving unrelated metadata", async () => {
    mockZavuFetch
      .mockResolvedValueOnce({
        id: "contact-1",
        metadata: {
          customerTier: "gold",
          [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "old-delivery",
          [VOICE_CONTEXT_METADATA_KEYS.objective]: "Old objective",
        },
      })
      .mockResolvedValueOnce({ id: "contact-1" });

    await setVoiceCallContactContext({
      phone: "+14155550100",
      deliveryId: "delivery-1",
      siteId: "site-1",
      objective: "Confirm the appointment",
      additionalContext: "Offer the afternoon slot.",
      followUpContext: "Previous call: requested an afternoon appointment.",
    });

    expect(mockZavuFetch).toHaveBeenNthCalledWith(
      2,
      "/contacts/contact-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          metadata: {
            customerTier: "gold",
            [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "delivery-1",
            [VOICE_CONTEXT_METADATA_KEYS.siteId]: "site-1",
            [VOICE_CONTEXT_METADATA_KEYS.objective]: "Confirm the appointment",
            [VOICE_CONTEXT_METADATA_KEYS.additionalContext]:
              "Offer the afternoon slot.",
            [VOICE_CONTEXT_METADATA_KEYS.followUpContext]:
              "Previous call: requested an afternoon appointment.",
          },
        }),
      })
    );
  });

  it("clears only the guidance owned by the completed delivery", async () => {
    mockZavuFetch
      .mockResolvedValueOnce({
        id: "contact-1",
        metadata: {
          customerTier: "gold",
          [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "delivery-1",
          [VOICE_CONTEXT_METADATA_KEYS.objective]: "Confirm the appointment",
        },
      })
      .mockResolvedValueOnce({ id: "contact-1" });

    await clearVoiceCallContactContext({
      phone: "+14155550100",
      deliveryId: "delivery-1",
    });

    expect(mockZavuFetch).toHaveBeenNthCalledWith(
      2,
      "/contacts/contact-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          metadata: {
            customerTier: "gold",
            [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "",
            [VOICE_CONTEXT_METADATA_KEYS.siteId]: "",
            [VOICE_CONTEXT_METADATA_KEYS.objective]: "",
            [VOICE_CONTEXT_METADATA_KEYS.additionalContext]: "",
            [VOICE_CONTEXT_METADATA_KEYS.followUpContext]: "",
          },
        }),
      })
    );
  });

  it("does not clear context belonging to a newer delivery", async () => {
    mockZavuFetch.mockResolvedValueOnce({
      id: "contact-1",
      metadata: {
        [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "delivery-2",
      },
    });

    await clearVoiceCallContactContext({
      phone: "+14155550100",
      deliveryId: "delivery-1",
    });

    expect(mockZavuFetch).toHaveBeenCalledTimes(1);
  });
});
