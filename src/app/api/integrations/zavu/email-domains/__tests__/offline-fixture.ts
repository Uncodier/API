import { jest } from "@jest/globals";
import { NextRequest } from "next/server";

type Row = { channels: any };
const mockFunction = () => jest.fn<(...args: any[]) => any>();
export const settings = new Map<string, Row>();
export const operations: string[] = [];
export const provider = { addEmailDomain: mockFunction(), getEmailDomain: mockFunction() };
export const refreshCaches = mockFunction();
export const getUser = mockFunction();
export const role = mockFunction();
export const faults: { read?: unknown; write?: unknown; insert?: unknown } = {};

class Query {
  private siteId = "";
  private mode = "read";
  private patch: Row | undefined;
  private expected: string | null | undefined;

  select() { return this; }
  eq(column: string, value: string) {
    if (column === "site_id") this.siteId = value;
    else if (column === "channels") this.expected = value;
    else throw new Error(`Unexpected filter: ${column}`);
    return this;
  }
  is(column: string, value: null) {
    if (column !== "channels") throw new Error("Unexpected null filter");
    this.expected = value;
    return this;
  }
  update(patch: Row) {
    this.mode = "write";
    this.patch = patch;
    return this;
  }
  async insert(row: Row & { site_id: string }) {
    operations.push(`insert:${row.site_id}`);
    const error = faults.insert || (settings.has(row.site_id) ? { code: "23505" } : null);
    if (!error) settings.set(row.site_id, structuredClone({ channels: row.channels }));
    return { error };
  }
  async maybeSingle() {
    const row = settings.get(this.siteId);
    operations.push(`${this.mode}:${this.siteId}`);
    if (this.mode === "read") {
      return { data: row ? structuredClone(row) : null, error: faults.read || null };
    }
    if (faults.write) return { data: null, error: faults.write };
    if (this.expected === undefined) throw new Error("Missing compare-and-swap filter");
    const matches = this.expected === null
      ? row?.channels === null
      : JSON.stringify(row?.channels) === this.expected;
    if (!matches || !row) return { data: null, error: null };
    settings.set(this.siteId, structuredClone(this.patch!));
    return { data: { site_id: this.siteId }, error: null };
  }
}

jest.unstable_mockModule("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table !== "settings") throw new Error("Unexpected table");
      operations.push("privileged-client");
      return new Query();
    },
  },
  createSupabaseClient: () => ({ auth: { getUser }, rpc: role }),
}));
jest.unstable_mockModule("@/lib/services/zavu/client", () => provider);
jest.unstable_mockModule("@/lib/services/site-configuration-cache", () => ({
  refreshSiteConfigurationCaches: refreshCaches,
}));

export function resetFixture() {
  jest.resetAllMocks();
  settings.clear();
  operations.length = 0;
  delete faults.read;
  delete faults.write;
  delete faults.insert;
  getUser.mockImplementation(async () => {
    operations.push("authenticate");
    return { data: { user: { id: "user_1" } }, error: null };
  });
  role.mockImplementation(async (_name, args) => {
    operations.push(`authorize:${args.p_site_id}`);
    return { data: "owner", error: null };
  });
  provider.addEmailDomain.mockImplementation(async (domain) => {
    operations.push("add-domain");
    return { id: "domain_new", domain, status: "pending", dnsRecords: [] };
  });
  provider.getEmailDomain.mockImplementation(async (id) => {
    operations.push("get-domain");
    return { id, domain: "example.test", status: "verified", dnsRecords: [{ type: "TXT", value: "fresh" }] };
  });
  refreshCaches.mockResolvedValue(undefined);
}

export function connection(id = "source", metadata: Record<string, unknown> = {}) {
  return {
    id, type: "email", name: "Existing Email", status: "pending",
    metadata: { domain: "example.test", email_domain_id: "domain_stored", ...metadata },
  };
}

export function putConnections(connections: any[], siteId = "site_1", extra = {}) {
  settings.set(siteId, { channels: { ...extra, connections } });
}

export function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest("https://api.example.test/api/integrations/zavu/email-domains", {
    method: "POST",
    body: JSON.stringify({ domain: "example.test", siteId: "site_1", channelId: "target", name: "New Email", ...overrides }),
  });
}

export function savedConnections(siteId = "site_1") {
  return settings.get(siteId)!.channels.connections;
}

export function expectNoProviderOrWrite() {
  expect(provider.addEmailDomain).not.toHaveBeenCalled();
  expect(provider.getEmailDomain).not.toHaveBeenCalled();
  expect(operations.some((operation) => /^(write|insert):/.test(operation))).toBe(false);
  expect(refreshCaches).not.toHaveBeenCalled();
}