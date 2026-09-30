const mockFrom = jest.fn();
const mockSchema = jest.fn(() => ({ from: mockFrom }));

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: { schema: mockSchema },
}));

import { identifyVoiceLead, normalizeVoiceIdentityPhone } from "../voice-lead-identification";

const SITE = "11111111-1111-4111-8111-111111111111";
const OTHER_SITE = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const OTHER_LEAD = "55555555-5555-4555-8555-555555555555";
const PHONE = "+13015550100"; // Do not drop the 0 (legacy normalizer does).
const EMAIL = "ada@example.com";
const validArgs = { consent: true, name: "Ada Caller", email: EMAIL, phone: PHONE };

type Row = Record<string, any>;
type Read = { table: string; filters: Array<[string, string]>; emailPattern?: string };

/** Offline, stateful PostgREST double including the actual PK/identity unique constraints. */
function database(initialLeads: Row[] = []) {
  const leads = initialLeads.map((row) => ({ ...row }));
  const sites: Row[] = [{ id: SITE, user_id: OWNER }, { id: OTHER_SITE, user_id: OWNER }];
  const reads: Read[] = [];
  const inserts: Row[] = [];
  const state = {
    leads, sites, reads, inserts,
    readError: null as null | { message: string },
    insertError: null as null | { code: string; message: string },
    beforeInsert: undefined as undefined | ((row: Row) => void),
  };
  mockFrom.mockImplementation((table: string) => {
    if (table !== "leads" && table !== "sites") throw new Error(`Unexpected table ${table}`);
    const read: Read = { table, filters: [] };
    let max = Infinity;
    const result = () => {
      reads.push(read);
      if (state.readError) return { data: null, error: state.readError };
      let rows = (table === "leads" ? leads : sites)
        .filter((row) => read.filters.every(([key, value]) => row[key] === value));
      if (read.emailPattern !== undefined) {
        const email = read.emailPattern.replace(/\\([\\%_])/g, "$1");
        rows = rows.filter((row) => row.email?.toLowerCase() === email.toLowerCase());
      }
      return { data: rows.slice(0, max).map((row) => ({ ...row })), error: null };
    };
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn((key, value) => { read.filters.push([key, value]); return chain; }),
      ilike: jest.fn((_key, value) => { read.emailPattern = value; return chain; }),
      limit: jest.fn((value) => { max = value; return chain; }),
      then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
      maybeSingle: jest.fn(async () => {
        const res = result();
        return { ...res, data: res.data?.[0] || null };
      }),
      insert: jest.fn(async (row) => {
        if (table !== "leads") throw new Error("Only leads may be inserted");
        inserts.push(row);
        state.beforeInsert?.(row);
        if (state.insertError) return { error: state.insertError };
        const duplicate = leads.some((lead) => lead.id === row.id || (
          lead.site_id === row.site_id && lead.name === row.name && lead.email === row.email
        ));
        if (duplicate) return { error: { code: "23505", message: "duplicate private detail" } };
        leads.push({ ...row });
        return { error: null };
      }),
    };
    return chain;
  });
  return state;
}

function identify(args: Row = validArgs, siteId = SITE, contactPhone: string | undefined = PHONE) {
  return identifyVoiceLead({ siteId, contactPhone, arguments: args });
}

describe("identifyVoiceLead", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates a usable lead without visitor or conversation, using only trusted scope and current columns", async () => {
    const db = database();
    const result = await identify({
      ...validArgs, name: " Ada Caller ", email: " Ada@Example.COM ", company: " Acme ",
      site_id: OTHER_SITE, user_id: OTHER_LEAD, lead_id: OTHER_LEAD,
      visitor_id: "invented-visitor", conversation: "invented-conversation",
      contact_info: { email: "other@example.com" }, command_id: OTHER_LEAD,
      metadata: { do_not_call: false }, voice_call_consent_status: "granted", status: "converted",
    });

    expect(result).toEqual({ success: true, lead_id: expect.any(String), is_new_lead: true });
    expect(result.lead_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(db.inserts).toEqual([{
      id: result.lead_id, site_id: SITE, user_id: OWNER,
      name: "Ada Caller", email: EMAIL, phone: PHONE,
      company: { name: "Acme" }, origin: "voice", status: "contacted",
      metadata: { voice_identification: {
        consent: true, consent_scope: "store_contact_details_and_be_contacted",
        consent_recorded_at: expect.any(String),
      } },
    }]);
    expect(db.reads.every((read) => read.filters.some(([key, value]) =>
      key === (read.table === "sites" ? "id" : "site_id") && value === SITE
    ))).toBe(true);
    expect(mockFrom.mock.calls.flat()).not.toContain("visitors");
    expect(mockFrom.mock.calls.flat()).not.toContain("conversations");
  });

  it.each([undefined, null, false, "true", 1])("rejects consent=%p before any database access", async (consent) => {
    database();
    await expect(identify({ ...validArgs, consent })).rejects.toThrow("Explicit caller consent");
    expect(mockSchema).not.toHaveBeenCalled();
  });

  it.each([
    { name: "   " }, { name: "\n" }, { name: 42 }, { name: "x".repeat(201) },
    { email: "" }, { email: undefined }, { email: "   " }, { email: "not-an-email" },
    { phone: "" }, { phone: null }, { company: {} },
  ])("rejects invalid/blank contact details %p without querying", async (patch) => {
    database();
    await expect(identify({ ...validArgs, ...patch })).rejects.toThrow("nonblank name and valid email");
    expect(mockSchema).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "3015550100", "+13015550100x", "+00000000000"])(
    "cannot use a supplied phone in place of missing/invalid trusted phone %p", async (phone) => {
      database();
      await expect(identifyVoiceLead({ siteId: SITE, contactPhone: phone, arguments: validArgs }))
        .rejects.toThrow("trusted caller phone");
      expect(mockSchema).not.toHaveBeenCalled();
    }
  );

  it("fails on a supplied phone conflicting with the trusted caller, rather than overwriting it", async () => {
    database();
    await expect(identify({ ...validArgs, phone: "+14155550199" })).rejects.toThrow("must match");
    expect(mockSchema).not.toHaveBeenCalled();
  });

  it.each(["", "site-1", " " + SITE])("rejects an invalid authoritative site %p before database access", async (siteId) => {
    database();
    await expect(identify(validArgs, siteId)).rejects.toThrow("authoritative site");
    expect(mockSchema).not.toHaveBeenCalled();
  });

  it("does not reuse matching identities belonging to another site", async () => {
    const db = database([{ id: OTHER_LEAD, site_id: OTHER_SITE, phone: PHONE, email: EMAIL }]);
    const result = await identify();
    expect(result.lead_id).not.toBe(OTHER_LEAD);
    expect(db.leads).toHaveLength(2);
    expect(db.leads[1].site_id).toBe(SITE);
  });

  it("preserves the entire existing caller profile, consent restrictions and non-normalized email", async () => {
    const existing = {
      id: LEAD, site_id: SITE, phone: PHONE, email: "Ada@Example.com", name: "Original name",
      status: "qualified", company: { name: "Original company" }, metadata: { private: true },
      do_not_call: true, voice_call_consent_status: "revoked",
    };
    const db = database([existing]);
    await expect(identify({ ...validArgs, name: "Replacement", company: "Replacement" }))
      .resolves.toEqual({ success: true, lead_id: LEAD, is_new_lead: false });
    expect(db.leads).toEqual([existing]);
    expect(db.inserts).toEqual([]);
    expect(db.reads.every((read) => read.table === "leads")).toBe(true);
  });

  it("never fills in an existing blank email based on a supplied unverified email", async () => {
    const db = database([{ id: LEAD, site_id: SITE, phone: PHONE, email: null }]);
    await expect(identify()).resolves.toMatchObject({ lead_id: LEAD, is_new_lead: false });
    expect(db.leads[0].email).toBeNull();
    expect(db.inserts).toEqual([]);
  });

  it.each([
    [{ id: LEAD, site_id: SITE, phone: PHONE, email: "other@example.com" }],
    [{ id: LEAD, site_id: SITE, phone: "+14155550199", email: EMAIL }],
    [{ id: LEAD, site_id: SITE, phone: null, email: EMAIL }],
    [
      { id: LEAD, site_id: SITE, phone: PHONE, email: null },
      { id: OTHER_LEAD, site_id: SITE, phone: "+14155550199", email: EMAIL },
    ],
    [
      { id: LEAD, site_id: SITE, phone: PHONE, email: EMAIL },
      { id: OTHER_LEAD, site_id: SITE, phone: PHONE, email: "other@example.com" },
    ],
    [
      { id: LEAD, site_id: SITE, phone: PHONE, email: EMAIL },
      { id: OTHER_LEAD, site_id: SITE, phone: "+14155550199", email: EMAIL.toUpperCase() },
    ],
  ])("fails closed on conflicting or ambiguous identity %#", async (...rows) => {
    const db = database(rows);
    await expect(identify()).rejects.toThrow("identity conflicts");
    expect(db.inserts).toEqual([]);
    expect(db.leads).toEqual(rows);
  });

  it("escapes email wildcard characters instead of matching unrelated identities", async () => {
    const db = database();
    await identify({ ...validArgs, email: "ada_tag@example.com" });
    expect(db.reads.find((read) => read.emailPattern)?.emailPattern)
      .toBe("ada\\_tag@example.com");
  });

  it("converges repeat calls despite formatting, case or optional-detail changes", async () => {
    const db = database();
    const first = await identify();
    const second = await identify({
      ...validArgs, name: "Changed optional profile", email: EMAIL.toUpperCase(),
      phone: "+1 (301) 555-0100", company: "New company",
    }, SITE, "0013015550100");
    expect(second).toEqual({ success: true, lead_id: first.lead_id, is_new_lead: false });
    expect(db.inserts).toHaveLength(1);
    expect(db.leads[0].name).toBe("Ada Caller");
  });

  it("uses a stable per-site/caller id across processes and a different id for other sites", async () => {
    database();
    const first = await identify();
    database(); // Simulates no shared in-process replay state.
    const replay = await identify({ ...validArgs, name: "Other name", company: "Acme" });
    expect(replay.lead_id).toBe(first.lead_id);
    const otherSite = await identify(validArgs, OTHER_SITE);
    expect(otherSite.lead_id).not.toBe(first.lead_id);
  });

  it("converges concurrent duplicate retries via PK conflict re-read, without any upsert", async () => {
    const db = database();
    const results = await Promise.all([identify(), identify()]);
    expect(results[0].lead_id).toBe(results[1].lead_id);
    expect(results.map((result) => result.is_new_lead).sort()).toEqual([false, true]);
    expect(db.inserts).toHaveLength(2);
    expect(db.leads).toHaveLength(1);
  });

  it("does not accept conflicting identity from a concurrent winner", async () => {
    const db = database();
    db.beforeInsert = (row) => db.leads.push({ ...row, email: "other@example.com" });
    await expect(identify()).rejects.toThrow("identity conflicts");
    expect(db.leads[0].email).toBe("other@example.com");
  });

  it("fails closed on lookup errors without creating a duplicate or leaking DB details", async () => {
    const db = database();
    db.readError = { message: "Private contact at other@example.com" };
    await expect(identify()).rejects.toThrow(/^Unable to check existing Voice lead identity$/);
    expect(db.inserts).toEqual([]);
  });

  it.each(["missing", "owner-missing"])("requires a valid authoritative site owner (%s)", async (mode) => {
    const db = database();
    if (mode === "missing") db.sites.length = 0;
    else db.sites[0].user_id = null;
    await expect(identify()).rejects.toThrow("site owner");
    expect(db.inserts).toEqual([]);
  });

  it.each(["23505", "23503", "42P01"])("does not mask failed inserts (%s) as success", async (code) => {
    const db = database();
    db.insertError = { code, message: "Private contact at other@example.com" };
    await expect(identify()).rejects.toThrow(/^Unable to create Voice lead$/);
    expect(db.leads).toEqual([]);
  });

  it("uses server-configured tenant schema, never a schema from tool arguments", async () => {
    const previous = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA;
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA = "configured_schema";
    try {
      database();
      await identify({ ...validArgs, schema: "attacker_schema" });
      expect(mockSchema.mock.calls).toEqual([["configured_schema"], ["configured_schema"]]);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA;
      else process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA = previous;
    }
  });
});

describe("normalizeVoiceIdentityPhone", () => {
  it.each(["+1 (301) 555-0100", "0013015550100", PHONE])("normalizes safe formatting %s", (phone) => {
    expect(normalizeVoiceIdentityPhone(phone)).toBe(PHONE);
  });
  it("does not guess countries, strip valid digits or treat extension/text as an identity", () => {
    expect(normalizeVoiceIdentityPhone("3015550100")).toBeUndefined();
    expect(normalizeVoiceIdentityPhone("+13015550100 ext 2")).toBeUndefined();
    expect(normalizeVoiceIdentityPhone("+5215512345678")).toBe("+5215512345678");
    expect(normalizeVoiceIdentityPhone(null)).toBeUndefined();
  });
});