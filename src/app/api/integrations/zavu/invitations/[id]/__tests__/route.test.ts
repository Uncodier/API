import { NextRequest } from "next/server";
import { GET } from "../route";
import * as zavu from "@/lib/services/zavu";

jest.mock("@/lib/services/zavu", () => ({
  getInvitation: jest.fn(),
  cancelInvitation: jest.fn(),
  handleInvitationStatusChanged: jest.fn(),
}));

describe("GET /api/integrations/zavu/invitations/[id]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("finalizes a completed invitation so the sender webhook is activated", async () => {
    (zavu.getInvitation as jest.Mock).mockResolvedValue({
      id: "inv_1",
      url: "https://dashboard.zavu.dev/invite/abc",
      token: "abc",
      status: "completed",
      senderId: "snd_1",
      connectedAccount: { channel: "whatsapp", id: "pn_1", name: "Acme" },
    });

    const res = await GET(new NextRequest("http://localhost/api/integrations/zavu/invitations/inv_1"), {
      params: Promise.resolve({ id: "inv_1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.invitation.senderId).toBe("snd_1");
    expect(zavu.handleInvitationStatusChanged).toHaveBeenCalledWith({
      invitationId: "inv_1",
      currentStatus: "completed",
      senderId: "snd_1",
      connectedAccount: { channel: "whatsapp", id: "pn_1", name: "Acme" },
    });
  });

  it("does not finalize a still-pending invitation", async () => {
    (zavu.getInvitation as jest.Mock).mockResolvedValue({
      id: "inv_2",
      url: "https://dashboard.zavu.dev/invite/def",
      token: "def",
      status: "pending",
      senderId: null,
    });

    const res = await GET(new NextRequest("http://localhost/api/integrations/zavu/invitations/inv_2"), {
      params: Promise.resolve({ id: "inv_2" }),
    });

    expect(res.status).toBe(200);
    expect(zavu.handleInvitationStatusChanged).not.toHaveBeenCalled();
  });
});
