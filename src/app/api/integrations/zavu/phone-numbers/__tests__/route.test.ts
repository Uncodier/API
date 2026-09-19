const mockRequireZavuSiteManager = jest.fn();
const mockGetOwnedNumbers = jest.fn();
const mockFilterPhoneNumbersForSite = jest.fn();
const mockAssertPhoneResourcesAvailable = jest.fn();
const mockPurchaseNumber = jest.fn();

jest.mock("@/lib/services/zavu", () => ({
  requireZavuSiteManager: mockRequireZavuSiteManager,
  getOwnedNumbers: mockGetOwnedNumbers,
  filterPhoneNumbersForSite: mockFilterPhoneNumbersForSite,
  assertPhoneResourcesAvailable: mockAssertPhoneResourcesAvailable,
  purchaseNumber: mockPurchaseNumber,
}));

import { NextRequest } from "next/server";
import { GET, POST } from "../route";

const SITE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("Zavu phone numbers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireZavuSiteManager.mockResolvedValue(undefined);
    mockGetOwnedNumbers.mockResolvedValue({
      items: [{ id: "phone_1", phoneNumber: "+14155550100" }],
    });
    mockFilterPhoneNumbersForSite.mockResolvedValue([
      { id: "phone_1", phoneNumber: "+14155550100" },
    ]);
    mockAssertPhoneResourcesAvailable.mockResolvedValue(undefined);
    mockPurchaseNumber.mockResolvedValue({
      phoneNumber: { id: "phone_2", phoneNumber: "+14155550200" },
    });
  });

  it("authorizes and tenant-filters owned numbers", async () => {
    const response = await GET(new NextRequest(
      `https://backend.example.com/api/integrations/zavu/phone-numbers?siteId=${SITE_ID}`
    ));

    expect(response.status).toBe(200);
    expect(mockRequireZavuSiteManager).toHaveBeenCalledWith(
      expect.any(NextRequest),
      SITE_ID
    );
    expect(mockFilterPhoneNumbersForSite).toHaveBeenCalledWith(
      SITE_ID,
      [{ id: "phone_1", phoneNumber: "+14155550100" }]
    );
  });

  it("rejects unauthenticated listing", async () => {
    mockRequireZavuSiteManager.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 })
    );

    const response = await GET(new NextRequest(
      `https://backend.example.com/api/integrations/zavu/phone-numbers?siteId=${SITE_ID}`
    ));

    expect(response.status).toBe(401);
    expect(mockGetOwnedNumbers).not.toHaveBeenCalled();
  });

  it("authorizes purchases and checks cross-site ownership", async () => {
    const response = await POST(new NextRequest(
      "https://backend.example.com/api/integrations/zavu/phone-numbers",
      {
        method: "POST",
        body: JSON.stringify({
          siteId: SITE_ID,
          phoneNumber: "+14155550200",
        }),
      }
    ));

    expect(response.status).toBe(200);
    expect(mockAssertPhoneResourcesAvailable).toHaveBeenCalledWith(SITE_ID, {
      phoneNumber: "+14155550200",
    });
  });
});
