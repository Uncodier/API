import { randomBytes } from "node:crypto";
import { jest } from "@jest/globals";
import { NextRequest } from "next/server";
import {
  connection, expectNoProviderOrWrite, faults, getUser, operations, provider,
  putConnections, refreshCaches, resetFixture, role, savedConnections, settings,
} from "../../__tests__/offline-fixture";

let GET: typeof import("../route").GET;
beforeAll(async () => { ({ GET } = await import("../route")); });
beforeEach(() => {
  resetFixture();
  putConnections([connection("target", { domain_status: "pending", dns_records: [] })]);
  jest.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in offline tests"); });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

function poll(id = "domain_stored", query = "siteId=site_1&channelId=target") {
  return GET(new NextRequest(`https://api.example.test/api/integrations/zavu/email-domains/${id}?${query}`), {
    params: Promise.resolve({ id }),
  });
}

function expectNoWrite() {
  expect(operations.some((operation) => /^(write|insert):/.test(operation))).toBe(false);
  expect(refreshCaches).not.toHaveBeenCalled();
}

describe("GET email domain polling", () => {
  it("refreshes pending to verified for an established sender, changing only status/DNS", async () => {
    const target = {
      ...connection("target", {
        domain: " EXAMPLE.TEST. ", domain_status: "pending", dns_records: [],
        emailReceivingEnabled: true, emailChannelActive: true, mx_verified: true,
        sender_id: "sender_1", routing: { sender_id: "sender_1" }, unrelated: { keep: true },
      }),
      zavu_sender_id: "sender_1", status: "connected", enabled: false,
      _license: { manually_disabled: true }, created_at: "2026-01-01", updated_at: "2026-01-02",
    };
    const other = connection("other");
    putConnections([target, other], "site_1", { email: { enabled: true }, custom: "keep" });
    const response = await poll();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ success: true, domain: {
      id: "domain_stored", domain: "example.test", status: "verified", dnsRecords: [{ type: "TXT", value: "fresh" }],
    } });
    expect(savedConnections()).toEqual([
      { ...target, metadata: { ...target.metadata, domain_status: "verified", dns_records: [{ type: "TXT", value: "fresh" }] } },
      other,
    ]);
    expect(settings.get("site_1")!.channels).toMatchObject({ email: { enabled: true }, custom: "keep" });
    expect(operations.slice(0, 5)).toEqual(["authenticate", "authorize:site_1", "privileged-client", "read:site_1", "get-domain"]);
    expect(provider.getEmailDomain).toHaveBeenCalledWith("domain_stored");
    expect(provider.addEmailDomain).not.toHaveBeenCalled();
    expect(refreshCaches).toHaveBeenCalledWith("site_1");
  });

  it("does not write when status and DNS are unchanged, regardless of object key order", async () => {
    const target = connection("target", { domain_status: "verified", dns_records: [{ value: "fresh", type: "TXT" }] });
    putConnections([target]);
    expect((await poll()).status).toBe(200);
    expect(savedConnections()).toEqual([target]);
    expectNoWrite();
  });

  it("persists DNS-only changes while leaving status/id/domain intact", async () => {
    putConnections([connection("target", { domain_status: "verified", dns_records: [{ type: "TXT", value: "stale" }] })]);
    expect((await poll()).status).toBe(200);
    expect(savedConnections()[0].metadata).toEqual({ domain: "example.test", email_domain_id: "domain_stored", domain_status: "verified", dns_records: [{ type: "TXT", value: "fresh" }] });
  });

  it("persists status-only changes while retaining identical DNS records", async () => {
    provider.getEmailDomain.mockResolvedValue({ id: "domain_stored", domain: "example.test", status: "verified", dnsRecords: [] });
    expect((await poll()).status).toBe(200);
    expect(savedConnections()[0].metadata).toEqual({ domain: "example.test", email_domain_id: "domain_stored", domain_status: "verified", dns_records: [] });
  });

  it("returns fresh pending without promoting sender/receiving/activation state", async () => {
    provider.getEmailDomain.mockResolvedValue({ id: "domain_stored", domain: "EXAMPLE.TEST.", status: "pending", dnsRecords: [{ type: "MX" }] });
    const response = await poll();
    expect(response.status).toBe(200);
    expect((await response.json()).domain.status).toBe("pending");
    expect(savedConnections()[0]).toEqual(connection("target", { domain_status: "pending", dns_records: [{ type: "MX" }] }));
  });
});

describe("polling authorization and persisted ownership", () => {
  it.each([401, 403])("returns %s without privileged/provider access", async (status) => {
    if (status === 401) getUser.mockResolvedValue({ data: { user: null }, error: null });
    else role.mockResolvedValue({ data: "member", error: null });
    const response = await poll();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: status === 401 ? "Unauthorized" : "Forbidden" });
    expect(operations).not.toContain("privileged-client");
    expectNoProviderOrWrite();
  });

  it("rejects an unauthorized site before reading its settings", async () => {
    putConnections([connection("target")], "site_2");
    role.mockImplementation(async (_name, args) => ({ data: args.p_site_id === "site_1" ? "owner" : null, error: null }));
    expect((await poll("domain_stored", "siteId=site_2&channelId=target")).status).toBe(403);
    expect(operations).not.toContain("privileged-client");
    expectNoProviderOrWrite();
  });

  it("returns 404 for a cross-site target without looking in the other site", async () => {
    putConnections([], "site_1");
    putConnections([connection("target")], "site_2");
    expect((await poll()).status).toBe(404);
    expect(operations.some((operation) => operation.endsWith(":site_2"))).toBe(false);
    expect(savedConnections("site_2")).toEqual([connection("target")]);
    expectNoProviderOrWrite();
  });

  it("returns 404 for absent site settings", async () => {
    settings.clear();
    expect((await poll()).status).toBe(404);
    expectNoProviderOrWrite();
  });

  it.each([
    { type: "voice" }, { metadata: { domain: "example.test", email_domain_id: "domain_other" } },
    { metadata: { domain: "example.test" } }, { metadata: {} },
    { metadata: { domain: "https://example.test", email_domain_id: "domain_stored" } },
    { metadata: { domain: "*.example.test", email_domain_id: "domain_stored" } },
    { metadata: { domain: 42, email_domain_id: "domain_stored" } },
  ])("rejects wrong type/ID/invalid stored domain %j before provider access", async (patch) => {
    putConnections([{ ...connection("target"), ...patch }]);
    expect((await poll()).status).toBe(409);
    expectNoProviderOrWrite();
  });

  it("rejects duplicate target IDs, even when only one is email", async () => {
    putConnections([connection("target"), { ...connection("target"), type: "voice" }]);
    expect((await poll()).status).toBe(409);
    expectNoProviderOrWrite();
  });

  it.each([
    "", "siteId=site_1", "channelId=target", "siteId=&channelId=target",
    "siteId=site_1&channelId=", "siteId=../site&channelId=target",
    "siteId=site_1&channelId=target&siteId=site_2",
    "siteId=site_1&channelId=target&channelId=other",
    "siteId=site_1&channelId=target&domain=other.test",
  ])("rejects malformed/duplicate/unexpected query %s", async (query) => {
    expect((await poll("domain_stored", query)).status).toBe(400);
    expect(getUser).not.toHaveBeenCalled();
    expectNoProviderOrWrite();
  });

  it.each(["", "../domain", "domain?query", " domain_stored "])("rejects malformed path ID %s", async (id) => {
    expect((await poll(id)).status).toBe(400);
    expectNoProviderOrWrite();
  });
});

describe("polling failures and races", () => {
  it.each([
    null, {}, { id: "domain_other", domain: "example.test", status: "verified" },
    { id: "domain_stored", domain: "other.test", status: "verified" },
    { id: "domain_stored", domain: "mail.example.test", status: "verified" },
    { id: "domain_stored", domain: "https://example.test", status: "verified" },
    { id: "domain_stored", domain: "example.test" },
    { id: "domain_stored", domain: "example.test", status: {} },
    { id: "domain_stored", domain: "example.test", status: "verified", dnsRecords: {} },
    { id: "domain_stored", domain: "example.test", status: "verified", dnsRecords: [null] },
  ])("rejects invalid provider response %j without writing", async (reply) => {
    const before = structuredClone(settings.get("site_1"));
    provider.getEmailDomain.mockResolvedValue(reply);
    expect((await poll()).status).toBe(502);
    expect(settings.get("site_1")).toEqual(before);
    expectNoWrite();
  });

  it("sanitizes provider errors and never creates a replacement domain", async () => {
    const sensitive = randomBytes(24).toString("hex");
    provider.getEmailDomain.mockRejectedValue(new Error(sensitive));
    const response = await poll();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(sensitive);
    expect(provider.addEmailDomain).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("fails closed on a database read error", async () => {
    faults.read = { message: "database detail" };
    expect((await poll()).status).toBe(500);
    expectNoProviderOrWrite();
  });

  it.each([{ connections: {} }, { connections: [{ metadata: [] }] }])("fails closed on malformed stored connections %j", async (channels) => {
    settings.set("site_1", { channels });
    expect((await poll()).status).toBe(500);
    expectNoProviderOrWrite();
  });

  it("does not report success or invalidate caches after a database write failure", async () => {
    const before = structuredClone(settings.get("site_1"));
    const sensitive = randomBytes(24).toString("hex");
    faults.write = { message: sensitive };
    const response = await poll();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(sensitive);
    expect(settings.get("site_1")).toEqual(before);
    expect(refreshCaches).not.toHaveBeenCalled();
  });

  it.each([
    { zavu_sender_id: "sender_new" },
    { metadata: { domain: "other.test", email_domain_id: "domain_other" } },
    { enabled: false, metadata: { emailReceivingEnabled: true, emailChannelActive: true } },
  ])("returns 409 without stale writes after a concurrent change %j", async (patch) => {
    const changed = { ...connection("target"), ...patch };
    provider.getEmailDomain.mockImplementation(async (id) => {
      putConnections([changed]);
      return { id, domain: "example.test", status: "verified", dnsRecords: [] };
    });
    expect((await poll()).status).toBe(409);
    expect(savedConnections()).toEqual([changed]);
    expect(refreshCaches).not.toHaveBeenCalled();
  });

  it("returns 409 if settings disappear while awaiting the provider", async () => {
    provider.getEmailDomain.mockImplementation(async (id) => {
      settings.delete("site_1");
      return { id, domain: "example.test", status: "verified", dnsRecords: [] };
    });
    expect((await poll()).status).toBe(409);
    expect(settings.has("site_1")).toBe(false);
    expect(refreshCaches).not.toHaveBeenCalled();
  });
});