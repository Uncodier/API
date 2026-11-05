import { handleInvitationStatusChanged } from "../invitation-finalization";
import { getInvitation } from "../client";
import { activateChannelConnection } from "../connection-activation";
import { getChannelConnection } from "../persist";
import { patchActivationConnection, requireActivationLicense } from "../activation-persistence";
import { supabaseAdmin } from "@/lib/database/supabase-server";

jest.mock("@/lib/database/supabase-server", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("../client", () => ({ getInvitation: jest.fn(), mapInvitationStatus: (status: string) => status }));
jest.mock("../connection-activation", () => ({ activateChannelConnection: jest.fn() }));
jest.mock("../persist", () => ({ getChannelConnection: jest.fn() }));
jest.mock("../activation-persistence", () => ({ patchActivationConnection: jest.fn(), requireActivationLicense: jest.fn() }));

let connection: any;
let rows: any[];
beforeEach(() => {
  jest.resetAllMocks();
  connection = { id: "channel", type: "whatsapp", status: "pending", zavu_invitation_id: "inv_1", metadata: {} };
  rows = [{ site_id: "site", channels: { connections: [connection] } }];
  const query: any = {
    select: jest.fn().mockReturnThis(), contains: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    then: (resolve: any) => Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  (getInvitation as jest.Mock).mockResolvedValue({ id: "inv_1", status: "completed", senderId: "sender" });
  (getChannelConnection as jest.Mock).mockImplementation(async () => connection);
  (patchActivationConnection as jest.Mock).mockImplementation(async (_site, _id, patch) => {
    connection = { ...connection, ...patch, metadata: { ...connection.metadata, ...patch.metadata } };
    return connection;
  });
  (activateChannelConnection as jest.Mock).mockImplementation(async () => ({ connection: { ...connection, status: "connected" } }));
});

it.each(["whatsapp", "messenger"])("finalizes %s through verified activation", async (channel) => {
  connection.type = channel;
  const result = await handleInvitationStatusChanged({ invitationId: "inv_1", senderId: "untrusted-event-sender" }, "site");
  expect(result.status).toBe("connected");
  expect(connection.zavu_sender_id).toBe("sender");
  expect(activateChannelConnection).toHaveBeenCalledWith("site", "channel", { senderId: "sender", type: channel, invitationId: "inv_1" });
  expect(patchActivationConnection).toHaveBeenCalledWith("site", "channel", expect.objectContaining({ status: "in_progress" }), expect.objectContaining({ invitationId: "inv_1" }));
});

it("retains sender and pending status after failure so the next webhook/poll can retry", async () => {
  (activateChannelConnection as jest.Mock).mockRejectedValueOnce(new Error("activation failed"));
  await expect(handleInvitationStatusChanged({ invitationId: "inv_1" })).rejects.toThrow("activation failed");
  expect(connection).toMatchObject({ status: "in_progress", zavu_sender_id: "sender", metadata: { activation_pending: true } });
  await expect(handleInvitationStatusChanged({ invitationId: "inv_1" })).resolves.toMatchObject({ status: "connected" });
});

it("ignores stale events and does not activate a still-pending provider invitation", async () => {
  (getInvitation as jest.Mock).mockResolvedValue({ id: "inv_1", status: "pending" });
  await handleInvitationStatusChanged({ invitationId: "inv_1", currentStatus: "completed", senderId: "sender" });
  expect(activateChannelConnection).not.toHaveBeenCalled();
});

it.each([{ status: "disabled" }, { license_suspended: true }, { enabled: false }])("preserves disabled connections %j", async (patch) => {
  Object.assign(connection, patch);
  await handleInvitationStatusChanged({ invitationId: "inv_1" });
  expect(activateChannelConnection).not.toHaveBeenCalled();
  expect(patchActivationConnection).not.toHaveBeenCalled();
});

it("does not reactivate an already finalized connection on repeated webhooks", async () => {
  connection.zavu_sender_id = "sender";
  connection.metadata.provider_channel_active = true;
  connection.metadata.activation_pending = false;
  connection.status = "connected";
  await handleInvitationStatusChanged({ invitationId: "inv_1" });
  expect(activateChannelConnection).not.toHaveBeenCalled();
  expect(requireActivationLicense).toHaveBeenCalled();
});

it.each([
  { id: "inv_1", status: "completed" },
  { id: "other", status: "completed", senderId: "sender" },
  { id: "inv_1", status: "completed", senderId: "sender", connectedAccount: { channel: "instagram" } },
])("refuses malformed/mismatched provider data %j", async (invitation) => {
  (getInvitation as jest.Mock).mockResolvedValue(invitation);
  await expect(handleInvitationStatusChanged({ invitationId: "inv_1" })).rejects.toThrow();
  expect(activateChannelConnection).not.toHaveBeenCalled();
});

it("refuses ambiguous ownership before fetching the provider", async () => {
  rows.push(rows[0]);
  await expect(handleInvitationStatusChanged({ invitationId: "inv_1" })).rejects.toThrow("ambiguous");
  expect(getInvitation).not.toHaveBeenCalled();
});