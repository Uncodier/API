const mockSelect = jest.fn();

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({ select: mockSelect }),
  },
}));

import {
  assertPhoneResourcesAvailable,
  filterPhoneNumbersForSite,
} from "../phone-ownership";

describe("Zavu phone ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelect.mockResolvedValue({
      data: [{
        site_id: "site-other",
        channels: {
          connections: [{
            type: "voice",
            status: "connected",
            zavu_sender_id: "sender_other",
            metadata: {
              phone_number_id: "phone_other",
              phone_number: "+14155550100",
            },
          }],
        },
      }],
      error: null,
    });
  });

  it("filters resources assigned to another site", async () => {
    await expect(filterPhoneNumbersForSite("site-current", [
      { id: "phone_other", phoneNumber: "+14155550100", senderId: "sender_other" },
      { id: "phone_free", phoneNumber: "+14155550200" },
    ])).resolves.toEqual([
      { id: "phone_free", phoneNumber: "+14155550200" },
    ]);
  });

  it("rejects sender IDs assigned to another site", async () => {
    await expect(assertPhoneResourcesAvailable("site-current", {
      senderId: "sender_other",
    })).rejects.toMatchObject({ status: 403 });
  });

  it("allows resources already assigned to the same site", async () => {
    await expect(assertPhoneResourcesAvailable("site-other", {
      phoneNumber: "+14155550100",
    })).resolves.toBeUndefined();
  });
});
