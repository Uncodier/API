const mockFrom = jest.fn();
const mockSchema = jest.fn(() => ({ from: mockFrom }));

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: { schema: mockSchema },
}));

import { identifyVoiceLead, normalizeVoiceIdentityPhone } from "../voice-lead-identification";
import { VoiceLeadValidationError } from "../voice-lead-errors";
import { v5 as uuidv5 } from "uuid";

const SITE = "11111111-1111-4111-8111-111111111111";
const OTHER_SITE = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const OTHER_LEAD = "55555555-5555-4555-8555-555555555555";
const PHONE = "+13015550100"; // Do not drop the 0 (legacy normalizer does).
const EMAIL = "ada@example.com";
const validArgs = { consent: true, name: "Ada Caller", email: EMAIL, phone: PHONE };

type Row = Record<string, any>;
type Read = { table: string; filters: Array<[string, unknown]>; emailPattern?: string; phonePattern?: string };

function provisionalLead(patch: Row = {}): Row {
  return {
    id: uuidv5(`zavu-voice-lead:${SITE}:${PHONE}`, uuidv5.URL),
    site_id: SITE, phone: PHONE, name: `Voice caller ${PHONE}`, email: null, company: null,
    origin: "voice", status: "contacted", voice_call_consent_status: "unknown",
    metadata: { voice_inbound: { source: "zavu_webhook", identity_status: "unverified", phone_source: "provider_call" } },
    ...patch,
  };
}

/** Offline, stateful PostgREST double including the actual PK/identity unique constraints. */
function database(initialLeads: Row[] = []) {
  const leads = initialLeads.map((row) => ({ ...row }));
  const sites: Row[] = [{ id: SITE, user_id: OWNER }, { id: OTHER_SITE, user_id: OWNER }];
  const reads: Read[] = [];
  const inserts: Row[] = [];
  const updates: Array<{ filters: Read["filters"]; payload: Row }> = [];
  const state = {
    leads, sites, reads, inserts, updates,
    readError: null as null | { message: string },
    insertError: null as null | { code: string; message: string },
    updateError: null as null | { code: string; message: string },
    beforeInsert: undefined as undefined | ((row: Row) => void),
    beforeUpdate: undefined as undefined | (() => void),
  };
  mockFrom.mockImplementation((table: string) => {
    if (table !== "leads" && table !== "sites") throw new Error(`Unexpected table ${table}`);
    const read: Read = { table, filters: [] };
    let max = Infinity;
    let update: Row | undefined;
    const result = () => {
      reads.push(read);
      if (state.readError) return { data: null, error: state.readError };
      if (update) {
        updates.push({ filters: [...read.filters], payload: update });
        state.beforeUpdate?.();
        if (state.updateError) return { data: null, error: state.updateError };
      }
      let rows = (table === "leads" ? leads : sites)
        .filter((row) => read.filters.every(([key, value]) => key === "metadata" || (key === "company" && typeof value === "string")
          ? JSON.stringify(row[key]) === value
          : (row[key] ?? null) === value));
      if (read.emailPattern !== undefined) {
        const email = read.emailPattern.replace(/\\([\\%_])/g, "$1");
        rows = rows.filter((row) => row.email?.toLowerCase() === email.toLowerCase());
      }
      if (read.phonePattern !== undefined) {
        const regex = new RegExp(`^${read.phonePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i');
        rows = rows.filter((row) => regex.test(row.phone || ''));
      }
      rows = rows.slice(0, max);
      if (update) rows.forEach((row) => Object.assign(row, update));
      return { data: rows.map((row) => structuredClone(row)), error: null };
    };
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn((key, value) => { read.filters.push([key, value]); return chain; }),
      is: jest.fn((key, value) => { read.filters.push([key, value]); return chain; }),
      update: jest.fn((payload) => { update = payload; return chain; }),
      ilike: jest.fn((key, value) => {
        if (key === "phone") read.phonePattern = value;
        else if (key === "email") read.emailPattern = value;
        else throw new Error(`Unexpected ilike column ${key}`);
        return chain;
      }),
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

    expect(result).toEqual({ success: true, lead_id: expect.any(String), is_new_lead: true, contact_details_saved: true });
    expect(result.lead_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(db.inserts).toEqual([{
      id: result.lead_id, site_id: SITE, user_id: OWNER,
      name: "Ada Caller", email: EMAIL, phone: PHONE,
      company: { name: "Acme" }, origin: "voice", status: "contacted",
      metadata: { voice_identification: {
        consent: true, consent_scope: "store_contact_details_and_be_contacted",
        consent_recorded_at: expect.any(String),
        identity_status: "caller_confirmed",
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
    await expect(identify({ ...validArgs, ...patch })).rejects.toMatchObject({
      code: "VOICE_LEAD_INVALID_DETAILS", fields: Object.keys(patch),
    });
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
    await expect(identify({ ...validArgs, phone: "+14155550199" })).rejects.toMatchObject({
      code: "VOICE_LEAD_PHONE_MISMATCH", fields: ["phone"],
    });
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
      .resolves.toMatchObject({ success: true, lead_id: LEAD, is_new_lead: false, contact_details_saved: false });
    expect(db.leads).toEqual([existing]);
    expect(db.inserts).toEqual([]);
    expect(db.reads.every((read) => read.table === "leads")).toBe(true);
  });

  it("never fills in an existing blank email based on a supplied unverified email", async () => {
    const db = database([{ id: LEAD, site_id: SITE, phone: PHONE, email: null }]);
    await expect(identify()).resolves.toMatchObject({ lead_id: LEAD, is_new_lead: false, contact_details_saved: false });
    expect(db.leads[0].email).toBeNull();
    expect(db.inserts).toEqual([]);
  });

  it.each([
    [PHONE, '+1 (301) 555-0100'], [PHONE, '0013015550100'], [PHONE, '13015550100'],
    ['+525543640787', '+52 (55) 4364-0787'], ['+525543640787', '525543640787'],
    ['+525543640787', '+5215543640787'], ['+525543640787', '5215543640787'],
    ['+525543640787', '0052 1 (55) 4364-0787'], ['+525543640787', '(55) 4364-0787'],
    ['+5215543640787', '+525543640787'],
  ])('reuses caller %s stored as %s in native identification without overwriting the profile', async (caller, stored) => {
    const existing = { id: LEAD, site_id: SITE, phone: stored, email: EMAIL, name: validArgs.name,
      do_not_call: true, voice_call_consent_status: 'denied' };
    const db = database([existing]);
    await expect(identify({ ...validArgs, phone: caller }, SITE, caller)).resolves.toMatchObject({
      lead_id: LEAD, is_new_lead: false, contact_details_saved: true,
    });
    expect(db.leads).toEqual([existing]);
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('does not create a duplicate when the national-format Mexican lead has no email', async () => {
    const db = database([{ id: LEAD, site_id: SITE, phone: '5543640787', email: null }]);
    await expect(identify({ ...validArgs, phone: undefined }, SITE, '+525543640787')).resolves.toMatchObject({
      lead_id: LEAD, is_new_lead: false, contact_details_saved: false,
    });
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('rejects multiple equivalent phone formats instead of preferring an exact text match', async () => {
    const db = database([
      { id: LEAD, site_id: SITE, phone: '+525543640787', email: EMAIL },
      { id: OTHER_LEAD, site_id: SITE, phone: '(55) 4364-0787', email: null },
    ]);
    await expect(identify({ ...validArgs, phone: undefined }, SITE, '+525543640787')).rejects.toThrow('identity conflicts');
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('does not identify a Danish caller as a Mexican national-format contact', async () => {
    const existing = { id: LEAD, site_id: SITE, phone: '(453) 234-5678', email: null };
    const db = database([existing]);
    await expect(identify({ ...validArgs, phone: undefined }, SITE, '+4532345678')).resolves.toMatchObject({ is_new_lead: true });
    expect(db.leads[0]).toEqual(existing);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].phone).toBe('+4532345678');
  });

  it.each([
    "Sergio punto Prado arroba m e punto com.",
    "Sergio punto Prado arroba me punto com.",
    "sergio.prado@m e.com",
  ])("saves a confirmed spoken email from the failed-call scenario: %s", async (email) => {
    const db = database();
    const result = await identify({ ...validArgs, email });
    expect(result.contact_details_saved).toBe(true);
    expect(db.leads[0].email).toBe("sergio.prado@me.com");
    expect(db.reads.find((read) => read.emailPattern)?.emailPattern).toBe("sergio.prado@me.com");
  });

  it("reports every invalid field without echoing caller data or blaming email for company", async () => {
    database();
    await expect(identify({ ...validArgs, name: "", company: { private: "private@example.com" } }))
      .rejects.toMatchObject({ code: "VOICE_LEAD_INVALID_DETAILS", fields: ["name", "company"] });
    await expect(identify({ ...validArgs, company: {} })).rejects.toThrow(/^Invalid Voice lead details\. company:/);
    expect(new VoiceLeadValidationError("VOICE_LEAD_INVALID_DETAILS", ["email"]).message)
      .toContain("ask the caller to spell only the unclear part");
    expect(mockSchema).not.toHaveBeenCalled();
  });

  it("keeps an alternate contact phone separate from caller identity and never matches on it", async () => {
    const db = database([{ id: OTHER_LEAD, site_id: SITE, phone: "+14155550199", email: "other@example.com" }]);
    const result = await identify({ ...validArgs, phone: undefined, callback_phone: "+1 (415) 555-0199" });
    const saved = db.leads.find((lead) => lead.id === result.lead_id)!;
    expect(saved.phone).toBe(PHONE);
    expect(saved.metadata.voice_identification).toMatchObject({ callback_phone: "+14155550199", callback_phone_verified: false });
    expect(saved.voice_call_consent_status).not.toBe("granted");
    expect(db.reads.filter((read) => read.table === "leads" && !read.emailPattern)
      .every((read) => read.phonePattern === '%1%3%0%1%5%5%5%0%1%0%0%')).toBe(true);
    expect(db.leads[0].email).toBe("other@example.com");
  });

  it.each([null, "", "4611721870", "+14155550199 ext 2", 14155550199])(
    "asks for a valid international callback_phone without guessing: %p", async (callback_phone) => {
      database();
      await expect(identify({ ...validArgs, callback_phone })).rejects.toMatchObject({
        code: "VOICE_LEAD_INVALID_DETAILS", fields: ["callback_phone"],
      });
      expect(mockSchema).not.toHaveBeenCalled();
    }
  );

  it("completes only a consented inbound placeholder, preserving identity, restrictions and metadata", async () => {
    const provisional = provisionalLead({ do_not_call: true, voice_call_consent_status: "revoked" });
    provisional.metadata.private = { keep: true };
    const db = database([provisional]);
    const result = await identify({ ...validArgs, phone: undefined, email: "ada arroba example punto com", company: "Acme", callback_phone: "+14155550199" });
    expect(result).toEqual({ success: true, lead_id: provisional.id, is_new_lead: false, contact_details_saved: true });
    expect(db.inserts).toEqual([]);
    expect(db.updates).toHaveLength(1);
    expect(db.leads[0]).toMatchObject({
      id: provisional.id, site_id: SITE, phone: PHONE, name: validArgs.name, email: EMAIL,
      company: { name: "Acme" }, do_not_call: true, voice_call_consent_status: "revoked", status: "contacted",
      metadata: {
        private: { keep: true }, voice_inbound: provisional.metadata.voice_inbound,
        voice_identification: { consent: true, identity_status: "caller_confirmed", callback_phone: "+14155550199", callback_phone_verified: false },
      },
    });
    expect(db.updates[0].filters).toEqual(expect.arrayContaining([
      ["id", provisional.id], ["site_id", SITE], ["phone", PHONE], ["email", null],
      ["name", provisional.name], ["company", null], ["metadata", JSON.stringify(provisional.metadata)],
    ]));
  });

  it.each([
    { id: LEAD }, { name: "Existing customer" }, { company: { name: "Existing" } },
    { company: [] }, { company: "" }, { company: { notes: "Do not replace" } },
    { origin: "chat" }, { metadata: {} }, { metadata: { voice_inbound: { source: "zavu_webhook" } } },
  ])("does not upgrade a non-placeholder profile %#", async (patch) => {
    const existing = provisionalLead(patch);
    const db = database([existing]);
    await expect(identify()).resolves.toMatchObject({ contact_details_saved: false });
    expect(db.leads).toEqual([existing]);
    expect(db.updates).toEqual([]);
  });

  it("does not upgrade a placeholder without explicit consent or with conflicting email identity", async () => {
    const provisional = provisionalLead();
    const db = database([provisional, { id: OTHER_LEAD, site_id: SITE, phone: "+14155550199", email: EMAIL }]);
    await expect(identify({ ...validArgs, consent: false })).rejects.toThrow("Explicit caller consent");
    await expect(identify()).rejects.toThrow("identity conflicts");
    expect(db.updates).toEqual([]);
    expect(db.leads[0]).toEqual(provisional);
  });

  it("converges duplicate concurrent placeholder confirmations without losing restrictions", async () => {
    const provisional = provisionalLead({ do_not_call: true });
    const db = database([provisional]);
    const results = await Promise.all([identify(), identify()]);
    expect(results.every((result) => result.lead_id === provisional.id && result.contact_details_saved)).toBe(true);
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0].do_not_call).toBe(true);
    expect(db.leads[0].email).toBe(EMAIL);
  });

  it("completes a placeholder with the live schema's empty company default", async () => {
    const db = database([provisionalLead({ company: {} })]);
    await expect(identify({ ...validArgs, company: "Acme" })).resolves.toMatchObject({ contact_details_saved: true });
    expect(db.leads[0].company).toEqual({ name: "Acme" });
    expect(db.updates[0].filters).toContainEqual(["company", "{}"]);
  });

  it("does not overwrite an empty company snapshot changed during confirmation", async () => {
    const db = database([provisionalLead({ company: {} })]);
    db.beforeUpdate = () => { db.leads[0].company = { name: "Concurrent company" }; };
    await expect(identify({ ...validArgs, company: "Acme" })).resolves.toMatchObject({ contact_details_saved: false });
    expect(db.leads[0].company).toEqual({ name: "Concurrent company" });
    expect(db.leads[0].email).toBeNull();
  });

  it("does not report success when a conflicting email profile appears during the update", async () => {
    const db = database([provisionalLead()]);
    db.beforeUpdate = () => db.leads.push({ id: OTHER_LEAD, site_id: SITE, email: EMAIL, phone: "+14155550199" });
    await expect(identify()).rejects.toThrow("identity conflicts");
    // No cross-profile reassignment or rollback of another writer's data.
    expect(db.leads[1]).toMatchObject({ id: OTHER_LEAD, email: EMAIL, phone: "+14155550199" });
  });

  it("does not overwrite a concurrently edited name, email, or private metadata", async () => {
    const db = database([provisionalLead()]);
    db.beforeUpdate = () => {
      Object.assign(db.leads[0], { name: "Concurrent owner", email: "different@example.com", metadata: { do_not_contact: true } });
    };
    await expect(identify()).rejects.toThrow("identity conflicts");
    expect(db.leads[0]).toMatchObject({ name: "Concurrent owner", email: "different@example.com", metadata: { do_not_contact: true } });
  });

  it("asks to retry rather than overwrite concurrent metadata on an otherwise empty placeholder", async () => {
    const db = database([provisionalLead()]);
    db.beforeUpdate = () => { db.leads[0].metadata = { ...db.leads[0].metadata, private: "new" }; };
    await expect(identify()).rejects.toThrow("changed during confirmation");
    expect(db.leads[0].email).toBeNull();
    expect(db.leads[0].metadata.private).toBe("new");
  });

  it("reports persistence failures without exposing database details or claiming success", async () => {
    const db = database([provisionalLead()]);
    db.updateError = { code: "23505", message: "private@example.com" };
    await expect(identify()).rejects.toThrow(/^Unable to save confirmed Voice contact details$/);
    expect(db.leads[0].email).toBeNull();
  });

  it("completes a webhook placeholder that wins the concurrent insert race", async () => {
    const db = database();
    db.beforeInsert = () => db.leads.push(provisionalLead());
    await expect(identify()).resolves.toMatchObject({ is_new_lead: false, contact_details_saved: true });
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0].email).toBe(EMAIL);
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
    expect(second).toMatchObject({ success: true, lead_id: first.lead_id, is_new_lead: false, contact_details_saved: false });
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

  it('does not identify or insert from a truncated phone candidate set', async () => {
    const db = database(Array.from({ length: 51 }, () => ({ id: LEAD, site_id: SITE, phone: PHONE, email: null })));
    await expect(identify()).rejects.toThrow('identity conflicts');
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('filters foreign-country and extra-digit candidates without matching on the suffix', async () => {
    const db = database([
      { id: LEAD, site_id: SITE, phone: '+15543640787', email: null },
      { id: OTHER_LEAD, site_id: SITE, phone: '+5255436407879', email: null },
    ]);
    await expect(identify({ ...validArgs, phone: undefined }, SITE, '+525543640787')).resolves.toMatchObject({ is_new_lead: true });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].phone).toBe('+525543640787');
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