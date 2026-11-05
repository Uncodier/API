import { NextRequest } from "next/server";
import { GET, DELETE } from "../route";
import { getInvitation, cancelInvitation } from "@/lib/services/zavu/client";
import { findInvitationConnection, handleInvitationStatusChanged } from "@/lib/services/zavu/invitation-finalization";
import { requireZavuSiteManager } from "@/lib/services/zavu/site-access";

jest.mock("@/lib/services/zavu/client", () => ({
  getInvitation: jest.fn(),
  cancelInvitation: jest.fn(),
}));
jest.mock("@/lib/services/zavu/invitation-finalization", () => ({
  handleInvitationStatusChanged: jest.fn(), findInvitationConnection: jest.fn(),
}));
jest.mock("@/lib/services/zavu/site-access", () => ({ requireZavuSiteManager: jest.fn() }));

const request = () => new NextRequest("http://localhost/api/integrations/zavu/invitations/inv_1?siteId=site_1");
const params = { params: Promise.resolve({ id: "inv_1" }) };

describe("GET /api/integrations/zavu/invitations/[id]", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (requireZavuSiteManager as jest.Mock).mockResolvedValue(undefined);
    (findInvitationConnection as jest.Mock).mockResolvedValue({ siteId: "site_1" });
  });

  it("finalizes a completed invitation so the sender webhook is activated", async () => {
    (handleInvitationStatusChanged as jest.Mock).mockResolvedValue({
      status: "connected", zavu_sender_id: "snd_1", metadata: { zavu_webhook_secret: "private-ciphertext" },
    });

    const res = await GET(request(), params);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.invitation.senderId).toBe("snd_1");
    expect(json.invitation.status).toBe("completed");
    expect(JSON.stringify(json)).not.toContain("private-ciphertext");
    expect(handleInvitationStatusChanged).toHaveBeenCalledWith({ invitationId: "inv_1" }, "site_1");
  });

  it("does not finalize a still-pending invitation", async () => {
    (handleInvitationStatusChanged as jest.Mock).mockResolvedValue({ status: "pending" });
    const res = await GET(request(), params);
    expect(res.status).toBe(200);
    expect((await res.json()).invitation.status).toBe("pending");
  });

  it("does not return completed when activation or webhook finalization fails", async () => {
    (handleInvitationStatusChanged as jest.Mock).mockRejectedValue(new Error("provider private details"));
    const response = await GET(request(), params);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toMatch(/completed|private details/);
  });

  it.each([401, 403])("denies unauthorized finalization (%s)", async (status) => {
    (requireZavuSiteManager as jest.Mock).mockRejectedValue({ status });
    expect((await GET(request(), params)).status).toBe(status);
    expect(findInvitationConnection).not.toHaveBeenCalled();
    expect(handleInvitationStatusChanged).not.toHaveBeenCalled();
  });

  it("denies a foreign invitation", async () => {
    (findInvitationConnection as jest.Mock).mockRejectedValue({ status: 404 });
    expect((await GET(request(), params)).status).toBe(404);
    expect(handleInvitationStatusChanged).not.toHaveBeenCalled();
  });

  it("requires a site and rejects malformed IDs", async () => {
    expect((await GET(new NextRequest("http://localhost/"), params)).status).toBe(400);
    expect((await GET(request(), { params: Promise.resolve({ id: "../other" }) })).status).toBe(400);
    expect(requireZavuSiteManager).not.toHaveBeenCalled();
  });

  it("authorizes cancellation and refuses completed invitations", async () => {
    (getInvitation as jest.Mock).mockResolvedValueOnce({ id: "inv_1", status: "completed" })
      .mockResolvedValueOnce({ id: "inv_1", status: "pending" });
    expect((await DELETE(request(), params)).status).toBe(409);
    expect(cancelInvitation).not.toHaveBeenCalled();
    expect((await DELETE(request(), params)).status).toBe(200);
    expect(cancelInvitation).toHaveBeenCalledWith("inv_1");
  });
});
