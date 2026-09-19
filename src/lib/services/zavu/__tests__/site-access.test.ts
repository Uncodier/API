const mockGetUser = jest.fn();
const mockRpc = jest.fn();

jest.mock("@/lib/database/supabase-server", () => ({
  createSupabaseClient: () => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
  }),
}));

import {
  requireZavuSiteAccess,
  requireZavuSiteManager,
} from "../site-access";

describe("requireZavuSiteManager", () => {
  const request = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
  });

  it("rejects unauthenticated requests", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: new Error("Invalid token"),
    });

    await expect(
      requireZavuSiteManager(request, "site-1")
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects users who are not site managers", async () => {
    mockRpc.mockResolvedValue({ data: "member", error: null });

    await expect(
      requireZavuSiteManager(request, "site-1")
    ).rejects.toMatchObject({ status: 403 });
  });

  it("allows a site member to request a safe resynchronization", async () => {
    mockRpc.mockResolvedValue({ data: "member", error: null });

    await expect(
      requireZavuSiteAccess(request, "site-1")
    ).resolves.toBe("member");
  });

  it.each(["owner", "admin"])("allows the %s role", async (role) => {
    mockRpc.mockResolvedValue({ data: role, error: null });

    await expect(
      requireZavuSiteManager(request, "site-1")
    ).resolves.toBeUndefined();
  });
});
