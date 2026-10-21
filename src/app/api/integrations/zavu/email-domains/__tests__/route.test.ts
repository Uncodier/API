import { randomBytes } from "node:crypto";
import { jest } from "@jest/globals";
import { NextRequest } from "next/server";
import {
  connection, expectNoProviderOrWrite, faults, getUser, operations, provider,
  putConnections, refreshCaches, request, resetFixture, role, savedConnections, settings,
} from "./offline-fixture";

let POST: typeof import("../route").POST;
beforeAll(async () => { ({ POST } = await import("../route")); });
beforeEach(() => {
  resetFixture();
  jest.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in offline tests"); });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe("server-derived same-site email domain reuse", () => {
  it("reuses a domain from another email connection only after manager authorization", async () => {
    const source = { ...connection(), zavu_sender_id: "sender_existing" };
    putConnections([source]);
    const response = await POST(request({ domain: "  EXAMPLE.TEST.  " }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true, reused: true,
      domain: { id: "domain_stored", domain: "example.test", status: "verified", dnsRecords: [{ type: "TXT", value: "fresh" }] },
    });
    expect(provider.getEmailDomain).toHaveBeenCalledWith("domain_stored");
    expect(provider.addEmailDomain).not.toHaveBeenCalled();
    expect(operations.slice(0, 5)).toEqual(["authenticate", "authorize:site_1", "privileged-client", "read:site_1", "get-domain"]);
    expect(savedConnections()[0]).toEqual(source);
    expect(savedConnections()[1]).toMatchObject({ id: "target", type: "email", name: "New Email", metadata: { email_domain_id: "domain_stored" } });
    expect(refreshCaches).toHaveBeenCalledWith("site_1");
  });

  it("refreshes stale pending domain fields without resetting independent state", async () => {
    const target = {
      ...connection("target", {
        domain: " EXAMPLE.TEST. ", domain_status: "pending", dns_records: [{ type: "TXT", value: "stale" }],
        emailReceivingEnabled: true, emailChannelActive: true, mx_verified: true,
        routing: { unrelated: true }, custom: "keep",
      }),
      status: "in_progress", enabled: false, _license: { manually_disabled: true },
      created_at: "2026-01-01", updated_at: "2026-01-02", custom: { keep: true },
    };
    putConnections([target], "site_1", { defaults: { keep: true } });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(savedConnections()).toEqual([{
      ...target,
      metadata: { ...target.metadata, domain: "example.test", domain_status: "verified", dns_records: [{ type: "TXT", value: "fresh" }] },
    }]);
    expect(settings.get("site_1")!.channels.defaults).toEqual({ keep: true });
    expect(provider.addEmailDomain).not.toHaveBeenCalled();
  });

  it("allows repeated identical IDs for the exact domain", async () => {
    putConnections([connection("one"), connection("two", { domain: "EXAMPLE.TEST." })]);
    expect((await POST(request())).status).toBe(200);
    expect(provider.getEmailDomain).toHaveBeenCalledTimes(1);
  });

  it.each(["mail.example.test", "otherexample.test", "example.test.other"])(
    "does not inherit the parent domain for %s", async (domain) => {
      putConnections([connection()]);
      const response = await POST(request({ domain }));
      expect(response.status).toBe(200);
      expect((await response.json()).reused).toBe(false);
      expect(provider.addEmailDomain).toHaveBeenCalledWith(domain);
      expect(provider.getEmailDomain).not.toHaveBeenCalled();
    }
  );

  it("does not inherit a child's domain for the parent", async () => {
    putConnections([connection("source", { domain: "mail.example.test" })]);
    expect((await POST(request())).status).toBe(200);
    expect(provider.getEmailDomain).not.toHaveBeenCalled();
    expect(provider.addEmailDomain).toHaveBeenCalledWith("example.test");
  });

  it("ignores matching metadata on non-email connections", async () => {
    putConnections([{ ...connection(), type: "voice" }]);
    expect((await POST(request())).status).toBe(200);
    expect(provider.getEmailDomain).not.toHaveBeenCalled();
  });

  it("ignores domains without a persisted provider ID", async () => {
    putConnections([connection("source", { email_domain_id: undefined })]);
    expect((await POST(request())).status).toBe(200);
    expect(provider.addEmailDomain).toHaveBeenCalledWith("example.test");
  });

  it("creates the exact normalized name when no same-site domain exists", async () => {
    const response = await POST(request({ domain: " MAIL.Example.Test. " }));
    expect(response.status).toBe(200);
    expect(provider.addEmailDomain).toHaveBeenCalledWith("mail.example.test");
    expect(await response.json()).toEqual({ success: true, reused: false, domain: { id: "domain_new", domain: "mail.example.test", status: "pending", dnsRecords: [] } });
    expect(savedConnections()[0].metadata.domain).toBe("mail.example.test");
  });

  it("initializes connections in existing settings with null channels", async () => {
    settings.set("site_1", { channels: null });
    expect((await POST(request())).status).toBe(200);
    expect(savedConnections()[0].id).toBe("target");
  });

  it.each(["", " \t\n ", undefined])("defaults a new channel name when blank or missing: %j", async (name) => {
    const response = await POST(request({ name }));
    expect(response.status).toBe(200);
    expect(savedConnections()[0].name).toBe("Email Channel");
    expect(provider.addEmailDomain).toHaveBeenCalledWith("example.test");
  });

  it.each(["", " \t\n ", undefined])("preserves an existing channel name when blank or missing: %j", async (name) => {
    putConnections([connection("target")]);
    const response = await POST(request({ name }));
    expect(response.status).toBe(200);
    expect(savedConnections()[0].name).toBe("Existing Email");
    expect(provider.getEmailDomain).toHaveBeenCalledWith("domain_stored");
    expect(provider.addEmailDomain).not.toHaveBeenCalled();
  });

  it("initializes the legacy empty array database default", async () => {
    settings.set("site_1", { channels: [] });
    expect((await POST(request())).status).toBe(200);
    expect(savedConnections()[0].id).toBe("target");
  });

  it("preserves legacy email settings and other channel settings", async () => {
    putConnections([], "site_1", { email: { enabled: false, incomingPort: "993" }, whatsapp: { enabled: true } });
    expect((await POST(request())).status).toBe(200);
    expect(settings.get("site_1")!.channels).toMatchObject({ email: { enabled: false, incomingPort: "993" }, whatsapp: { enabled: true } });
  });
});

describe("authentication and site isolation", () => {
  it("returns 401 before any privileged read for an unauthenticated request", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(request())).status).toBe(401);
    expect(role).not.toHaveBeenCalled();
    expect(operations).toEqual([]);
    expectNoProviderOrWrite();
  });

  it.each(["member", "viewer", null])("returns 403 for the %s role", async (data) => {
    role.mockResolvedValue({ data, error: null });
    expect((await POST(request())).status).toBe(403);
    expect(operations).toEqual(["authenticate"]);
    expectNoProviderOrWrite();
  });

  it("fails closed when the role lookup fails", async () => {
    role.mockResolvedValue({ data: "owner", error: { message: "database detail" } });
    expect((await POST(request())).status).toBe(403);
    expectNoProviderOrWrite();
  });

  it("does not access another site for a manager authorized only on site_1", async () => {
    putConnections([connection()], "site_2");
    role.mockImplementation(async (_name, args) => ({ data: args.p_site_id === "site_1" ? "admin" : null, error: null }));
    expect((await POST(request({ siteId: "site_2" }))).status).toBe(403);
    expect(operations).toEqual(["authenticate"]);
    expectNoProviderOrWrite();
  });

  it("never reuses IDs or overwrites a same-named target from another site", async () => {
    const otherSite = [connection("target"), connection("source", { email_domain_id: "domain_other" })];
    putConnections(otherSite, "site_2");
    putConnections([], "site_1");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).reused).toBe(false);
    expect(provider.getEmailDomain).not.toHaveBeenCalled();
    expect(provider.addEmailDomain).toHaveBeenCalledWith("example.test");
    expect(savedConnections("site_2")).toEqual(otherSite);
    expect(operations.some((operation) => operation.endsWith(":site_2"))).toBe(false);
  });
});

describe("validation and protected targets", () => {
  it.each([
    "https://example.test", "//example.test", "example.test/path", "example.test:443",
    "user@example.test", "example.test?x=1", "example.test#fragment", "*.example.test",
    "example..test", "example.test..", "-example.test", "example-.test", "example_test.test",
    "localhost", "127.0.0.1", "[::1]", "", "   ", "exa mple.test", "example.test\\path",
    "éxample.test", `${"a".repeat(64)}.test`, `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.test`,
    42, null,
  ])("rejects invalid domains: %s", async (domain) => {
    expect((await POST(request({ domain }))).status).toBe(400);
    expect(getUser).not.toHaveBeenCalled();
    expectNoProviderOrWrite();
  });

  it.each([
    { siteId: undefined }, { channelId: undefined }, { siteId: " " }, { channelId: "" },
    { siteId: 5 }, { channelId: "../target" }, { name: {} },
    { domainId: "client_domain" }, { emailDomainId: "client_domain" },
    { status: "verified" }, { email_domain_id: "client_domain" },
  ])("rejects invalid/privileged input: %j", async (overrides) => {
    expect((await POST(request(overrides))).status).toBe(400);
    expectNoProviderOrWrite();
  });

  it("returns 400 for malformed JSON", async () => {
    expect((await POST(new NextRequest("https://api.example.test", { method: "POST", body: "{" }))).status).toBe(400);
    expectNoProviderOrWrite();
  });

  it.each([
    { type: "voice" }, { zavu_sender_id: "sender_created" },
    { metadata: { sender_id: "sender_created" } },
    { metadata: { zavu_sender_id: "sender_created" } },
    { metadata: { routing: { sender_id: "sender_created" } } },
  ])("rejects wrong-type/established targets: %j", async (override) => {
    const target = { ...connection("target"), ...override };
    putConnections([target]);
    expect((await POST(request())).status).toBe(409);
    expect(savedConnections()).toEqual([target]);
    expectNoProviderOrWrite();
  });

  it("rejects distinct IDs for the exact same normalized domain", async () => {
    putConnections([connection("one"), connection("two", { domain: "EXAMPLE.TEST.", email_domain_id: "domain_conflict" })]);
    const before = structuredClone(settings.get("site_1"));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Email domain connection conflict" });
    expect(settings.get("site_1")).toEqual(before);
    expectNoProviderOrWrite();
  });

  it("rejects duplicate target connection IDs", async () => {
    putConnections([connection("target"), connection("target")]);
    expect((await POST(request())).status).toBe(409);
    expectNoProviderOrWrite();
  });

  it("rejects unsafe stored provider IDs before a provider read", async () => {
    putConnections([connection("source", { email_domain_id: "../domain?query" })]);
    expect((await POST(request())).status).toBe(409);
    expectNoProviderOrWrite();
  });
});

describe("provider and persistence failures", () => {
  const invalidReplies = [
    null, {}, { id: 42 }, { id: "" }, { id: "../domain" },
    { domain: "example.test", status: "pending" },
    { id: "domain_stored", domain: "https://example.test", status: "verified" },
    { id: "domain_stored", domain: "other.test", status: "verified" },
    { id: "domain_stored", domain: "mail.example.test", status: "verified" },
    { id: "domain_stored", domain: "example.test" },
    { id: "domain_stored", domain: "example.test", status: {} },
    { id: "domain_stored", domain: "example.test", status: "verified", dnsRecords: {} },
    { id: "domain_stored", domain: "example.test", status: "verified", dnsRecords: [null] },
  ];
  describe.each([true, false])("reused=%s", (reused) => {
    it.each(invalidReplies)("does not write malformed/mismatched reply %j", async (reply) => {
      putConnections(reused ? [connection()] : []);
      const before = structuredClone(settings.get("site_1"));
      (reused ? provider.getEmailDomain : provider.addEmailDomain).mockResolvedValue(reply);
      expect((await POST(request())).status).toBe(502);
      expect(settings.get("site_1")).toEqual(before);
      expect(operations.some((operation) => operation.startsWith("write:"))).toBe(false);
      expect(refreshCaches).not.toHaveBeenCalled();
    });

    it("sanitizes provider errors and never falls back from reuse to create", async () => {
      const sensitive = randomBytes(24).toString("hex");
      putConnections(reused ? [connection()] : []);
      (reused ? provider.getEmailDomain : provider.addEmailDomain).mockRejectedValue(new Error(sensitive));
      const response = await POST(request());
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain(sensitive);
      expect(operations.some((operation) => operation.startsWith("write:"))).toBe(false);
      if (reused) expect(provider.addEmailDomain).not.toHaveBeenCalled();
    });
  });

  it("does not accept a different provider ID during reuse", async () => {
    putConnections([connection()]);
    provider.getEmailDomain.mockResolvedValue({ id: "domain_other", domain: "example.test", status: "verified" });
    expect((await POST(request())).status).toBe(502);
    expect(operations.some((operation) => operation.startsWith("write:"))).toBe(false);
  });

  it("normalizes the provider hostname and strips unrelated provider fields", async () => {
    provider.addEmailDomain.mockResolvedValue({ id: "domain_new", domain: " EXAMPLE.TEST. ", status: "pending", private: "not-for-client" });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).domain).toEqual({ id: "domain_new", domain: "example.test", status: "pending", dnsRecords: [] });
  });

  it("fails closed and sanitizes database read errors", async () => {
    const sensitive = randomBytes(24).toString("hex");
    faults.read = { message: sensitive };
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(sensitive);
    expectNoProviderOrWrite();
  });

  it.each(["bad", [{ type: "email" }], { connections: {} }, { connections: [null] }, { connections: [{ metadata: [] }] }])(
    "fails closed on malformed channels %j", async (channels) => {
      settings.set("site_1", { channels });
      expect((await POST(request())).status).toBe(500);
      expectNoProviderOrWrite();
    }
  );

  it("does not report success or invalidate caches when a database update fails", async () => {
    putConnections([connection()]);
    const before = structuredClone(settings.get("site_1"));
    faults.write = { message: "database detail" };
    expect((await POST(request())).status).toBe(500);
    expect(settings.get("site_1")).toEqual(before);
    expect(refreshCaches).not.toHaveBeenCalled();
  });

  it("does not report success when a settings insert fails", async () => {
    faults.insert = { message: "database detail" };
    expect((await POST(request())).status).toBe(500);
    expect(settings.has("site_1")).toBe(false);
    expect(refreshCaches).not.toHaveBeenCalled();
  });

  it("returns a safe conflict for a concurrent settings insert", async () => {
    faults.insert = { code: "23505" };
    expect((await POST(request())).status).toBe(409);
    expect(refreshCaches).not.toHaveBeenCalled();
  });

  it.each([{ zavu_sender_id: "sender_concurrent" }, { enabled: false, metadata: { emailReceivingEnabled: true } }])(
    "cannot overwrite a concurrent sender/state change %j", async (patch) => {
      putConnections([connection("target")]);
      const changed = { ...connection("target"), ...patch };
      provider.getEmailDomain.mockImplementation(async (id) => {
        putConnections([changed]);
        return { id, domain: "example.test", status: "verified", dnsRecords: [] };
      });
      expect((await POST(request())).status).toBe(409);
      expect(savedConnections()).toEqual([changed]);
      expect(refreshCaches).not.toHaveBeenCalled();
    }
  );
});