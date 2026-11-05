import { randomUUID } from "node:crypto";
import { handleDomainStatusChanged } from "../domain-status";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { refreshSiteConfigurationCaches } from "@/lib/services/site-configuration-cache";
import { activateVerifiedEmailConnections } from "../email-domain-activation";

jest.mock("@/lib/database/supabase-server", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/services/site-configuration-cache", () => ({ refreshSiteConfigurationCaches: jest.fn() }));
jest.mock("../email-domain-activation", () => ({ activateVerifiedEmailConnections: jest.fn() }));

const connection = () => ({ id: "email", type: "email", zavu_sender_id: "sender",
  status: "pending", metadata: { email_domain_id: "domain", activation_pending: true } });
const site = (connections: any[]) => ({ id: "settings", site_id: "site", channels: { connections, extra: true } });
let writes: any[];
let filters: any[][];
function arrange(initial: any[], responses: any[]) {
  (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
    const conditions: any[] = [];
    const query: any = {
      select: jest.fn(() => query),
      contains: jest.fn().mockResolvedValue({ data: initial }),
      eq: jest.fn((...args) => { conditions.push(args); return query; }),
      update: jest.fn((patch) => { writes.push(patch); filters.push(conditions); return query; }),
      maybeSingle: jest.fn(async () => {
        if (!responses.length) throw new Error("Unexpected database call");
        return responses.shift();
      }),
    };
    return query;
  });
}
beforeEach(() => { jest.resetAllMocks(); writes = []; filters = []; });

it("retries with a fresh snapshot preserving another channel's secret and uses canonical saved connections", async () => {
  const initial = site([connection(), { id: "sms", metadata: {} }]);
  const fresh = site([connection(), { id: "sms", metadata: { webhook_secret: randomUUID() } }]);
  const canonical = [{ ...connection(), metadata: { domain_status: "verified", canonical: true } }];
  arrange([initial], [{ data: null }, { data: fresh }, { data: { channels: { connections: canonical } } }]);
  await handleDomainStatusChanged({ domainId: "domain" }, "domain.verified");
  expect(writes).toHaveLength(2);
  expect(writes[1].channels.connections[1]).toEqual(fresh.channels.connections[1]);
  expect(writes[1].channels.extra).toBe(true);
  expect(filters[0]).toContainEqual(["channels", JSON.stringify(initial.channels)]);
  expect(filters[1]).toContainEqual(["channels", JSON.stringify(fresh.channels)]);
  expect(filters[1]).toContainEqual(["site_id", "site"]);
  expect(activateVerifiedEmailConnections).toHaveBeenCalledWith("site", "domain", canonical);
  expect(refreshSiteConfigurationCaches).toHaveBeenCalledWith("site");
});

it.each([
  [],
  [{ ...connection(), id: "replacement" }],
  [{ ...connection(), zavu_sender_id: "replacement" }],
  [{ ...connection(), metadata: { email_domain_id: "replacement" } }],
  [{ ...connection(), type: "sms" }],
].map((replacement) => ({ replacement })))("does not recreate or transfer updates onto a deleted/replaced association: %j", async ({ replacement }) => {
  arrange([site([connection()])], [{ data: null }, { data: site(replacement) }]);
  await handleDomainStatusChanged({ id: "domain" }, "domain.verified");
  expect(writes).toHaveLength(1);
  expect(activateVerifiedEmailConnections).not.toHaveBeenCalled();
  expect(refreshSiteConfigurationCaches).not.toHaveBeenCalled();
});

it("preserves same-channel metadata, sender, status and concurrent disable while updating domain status", async () => {
  const updated = { ...connection(), enabled: false, status: "disabled", license_suspended: true,
    metadata: { ...connection().metadata, webhook_secret: randomUUID(), label: "New label" } };
  const fresh = site([updated]);
  arrange([site([connection()])], [{ data: null }, { data: fresh }, { data: fresh }]);
  await handleDomainStatusChanged({ domainId: "domain" }, "domain.verified");
  expect(writes[1].channels.connections[0]).toEqual({ ...updated,
    metadata: { ...updated.metadata, domain_status: "verified" }, updated_at: expect.any(String) });
  // The existing activation helper receives the persisted disable, not the stale setup state.
  expect(activateVerifiedEmailConnections).toHaveBeenCalledWith("site", "domain", fresh.channels.connections);
});

it("bounds conflicts to three CAS attempts and propagates failure for webhook retry", async () => {
  const initial = site([connection()]);
  arrange([initial], [{ data: null }, { data: initial }, { data: null }, { data: initial }, { data: null }]);
  await expect(handleDomainStatusChanged({ id: "domain" }, "domain.verified")).rejects.toThrow("concurrently");
  expect(writes).toHaveLength(3);
  expect(activateVerifiedEmailConnections).not.toHaveBeenCalled();
});

it("retries the webhook when setup attaches a draft sender, then saves and activates the fresh association", async () => {
  const draft = site([{ ...connection(), zavu_sender_id: undefined }]);
  const attached = site([connection()]);
  arrange([draft], [{ data: null }, { data: attached }]);
  await expect(handleDomainStatusChanged({ id: "domain" }, "domain.verified"))
    .rejects.toThrow("sender attached concurrently");
  expect(writes).toHaveLength(1);
  expect(refreshSiteConfigurationCaches).not.toHaveBeenCalled();
  expect(activateVerifiedEmailConnections).not.toHaveBeenCalled();

  const saved = site([{ ...connection(), metadata: { ...connection().metadata, domain_status: "verified" } }]);
  arrange([attached], [{ data: saved }]);
  await handleDomainStatusChanged({ id: "domain" }, "domain.verified");
  expect(writes).toHaveLength(2);
  expect(writes[1].channels.connections[0].metadata.domain_status).toBe("verified");
  expect(activateVerifiedEmailConnections).toHaveBeenCalledWith("site", "domain", saved.channels.connections);
});

it.each(["write", "read"])("propagates %s errors without activation", async (operation) => {
  const error = new Error("database unavailable");
  arrange([site([connection()])], operation === "write" ? [{ error }] : [{ data: null }, { error }]);
  await expect(handleDomainStatusChanged({ id: "domain" }, "domain.verified")).rejects.toBe(error);
  expect(activateVerifiedEmailConnections).not.toHaveBeenCalled();
});

it("propagates lookup errors", async () => {
  const error = new Error("lookup unavailable");
  (supabaseAdmin.from as jest.Mock).mockReturnValue({ select: () => ({ contains: async () => ({ error }) }) });
  await expect(handleDomainStatusChanged({ id: "domain" }, "domain.verified")).rejects.toBe(error);
});

it("saves failed status without activation", async () => {
  const initial = site([connection()]);
  arrange([initial], [{ data: initial }]);
  await handleDomainStatusChanged({ id: "domain" }, "domain.failed");
  expect(writes[0].channels.connections[0].metadata.domain_status).toBe("failed");
  expect(activateVerifiedEmailConnections).not.toHaveBeenCalled();
});

it("propagates activation errors after a successful save", async () => {
  const initial = site([connection()]);
  arrange([initial], [{ data: initial }]);
  (activateVerifiedEmailConnections as jest.Mock).mockRejectedValue(new Error("activation unavailable"));
  await expect(handleDomainStatusChanged({ id: "domain" }, "domain.verified")).rejects.toThrow("activation unavailable");
});