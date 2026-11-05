import { activateVerifiedEmailConnections } from "../email-domain-activation";
import { getEmailDomain } from "../client";
import { activateChannelConnection } from "../connection-activation";

jest.mock("../client", () => ({ getEmailDomain: jest.fn() }));
jest.mock("../connection-activation", () => ({ activateChannelConnection: jest.fn() }));
const pending = { id: "channel", type: "email", zavu_sender_id: "sender", metadata: { email_domain_id: "domain", activation_pending: true } };
beforeEach(() => {
  jest.resetAllMocks();
  (getEmailDomain as jest.Mock).mockResolvedValue({ id: "domain", status: "verified" });
});
it("activates a pending sender after authoritative domain verification", async () => {
  await activateVerifiedEmailConnections("site", "domain", [pending]);
  expect(activateChannelConnection).toHaveBeenCalledWith("site", "channel", { senderId: "sender", type: "email" });
});
it.each([{ id: "domain", status: "pending" }, { id: "other", status: "verified" }])("does not activate unverified/mismatched domains %j", async (domain) => {
  (getEmailDomain as jest.Mock).mockResolvedValue(domain);
  await activateVerifiedEmailConnections("site", "domain", [pending]);
  expect(activateChannelConnection).not.toHaveBeenCalled();
});
it("leaves disabled, unrelated and historical accounts untouched", async () => {
  await activateVerifiedEmailConnections("site", "domain", [
    { ...pending, enabled: false }, { ...pending, license_suspended: true },
    { ...pending, metadata: { email_domain_id: "domain" } },
    { ...pending, metadata: { email_domain_id: "other", activation_pending: true } },
  ]);
  expect(getEmailDomain).not.toHaveBeenCalled();
});
it("propagates failures for durable webhook retries", async () => {
  (activateChannelConnection as jest.Mock).mockRejectedValue(new Error("retry"));
  await expect(activateVerifiedEmailConnections("site", "domain", [pending])).rejects.toThrow("retry");
});