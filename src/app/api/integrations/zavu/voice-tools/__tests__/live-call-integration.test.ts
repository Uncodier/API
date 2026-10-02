import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const mockFrom = jest.fn();
const mockGetVoiceCall = jest.fn();
let mockSecret: string;
jest.mock("@/lib/database/supabase-server", () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
  supabaseAdmin: { from: mockFrom, schema: () => ({ from: mockFrom }) },
}));
jest.mock("@/lib/utils/token-decryption", () => ({ decryptToken: () => mockSecret }));
jest.mock("@/lib/services/zavu/voice-call-client", () => ({ getVoiceCall: mockGetVoiceCall }));
jest.mock("@/lib/services/zavu/contact-client", () => ({
  setVoiceCallContactContext: jest.fn(), clearVoiceCallContactContext: jest.fn(),
}));
jest.mock("@/lib/services/zavu/voice-agent-context", () => ({
  // Optional provider guidance is unavailable; persistence and tools must still work.
  ensureVoiceContactMetadataEnabled: jest.fn(async () => { throw new Error("Offline provider"); }),
}));

import { POST } from "../route";
import { handleUntrackedInboundVoiceEvent } from "@/lib/services/zavu/inbound-voice-context";
import { inboundDatabase, SITE, OTHER_SITE, PHONE, CALL } from "@/lib/services/zavu/__tests__/inbound-lead-test-database";

const assistance = {
  summary: "Caller needs a person", message: "Please assist the current caller", priority: "normal",
  name: null, email: null, lead_id: "unknown", conversation_id: "unknown",
};
const identity = {
  name: "Ada Caller", email: "ada_caller@example.test", consent: true,
  phone: null, callback_phone: null, company: null,
};
const booking = {
  action: "schedule", title: "Consultation", start_datetime: "2026-10-15T14:00:00Z",
  duration: 30, timezone: "UTC", location: null, description: null, participants: null,
};

function request(tool: string, args: Record<string, unknown>, authentication = "signed") {
  const payload = { tool, arguments: args, context: { contactPhone: PHONE, sessionId: "opaque-session" } };
  const signedBody = JSON.stringify(payload);
  const signature = createHmac("sha256", mockSecret).update(signedBody).digest("hex");
  if (authentication === "tampered") payload.context.contactPhone = "+13015550199";
  const url = new URL("https://api.example.test/api/integrations/zavu/voice-tools");
  url.searchParams.set("siteId", SITE);
  return new NextRequest(url, {
    method: "POST", body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      ...(authentication === "unsigned" ? {} : { "x-zavu-signature": signature }),
    },
  });
}

describe("live inbound call through signed POST, real identity/executor/catalog and stateful persistence", () => {
  let state: ReturnType<typeof inboundDatabase>;
  let transport: jest.SpyInstance;
  let encryptedSecret: string;
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
  const originalApiKey = process.env.SERVICE_API_KEY;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecret = randomBytes(32).toString("hex");
    encryptedSecret = randomBytes(48).toString("base64");
    process.env.NEXT_PUBLIC_API_URL = "https://backend.example.test";
    process.env.SERVICE_API_KEY = randomBytes(32).toString("hex");
    state = inboundDatabase(mockFrom, {
      agents: [{ id: randomUUID(), site_id: SITE, role: "Customer Support",
        configuration: { zavu: { tool_webhook_secret: encryptedSecret } } }],
    });
    // Match database defaults for the real webhook's intentionally minimal insert.
    state.beforeInsert = row => { row.email ??= null; row.company ??= {}; };
    mockGetVoiceCall.mockResolvedValue({
      id: CALL, direction: "inbound", from: PHONE, senderId: "sender-1", status: "initiated",
    });
    transport = jest.spyOn(global, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected HTTP target in offline integration");
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.SERVICE_API_KEY;
    else process.env.SERVICE_API_KEY = originalApiKey;
  });

  async function initiate() {
    const result = await handleUntrackedInboundVoiceEvent({
      type: "call.initiated", senderId: "sender-1", data: { callId: CALL },
    }, CALL);
    expect(result.handled).toBe(true);
    expect(mockGetVoiceCall).toHaveBeenCalledWith(CALL);
    expect(state.tables.leads).toHaveLength(1);
    const lead = state.tables.leads[0];
    expect(lead).toMatchObject({
      site_id: SITE, phone: PHONE, email: null, name: `Voice caller ${PHONE}`,
      voice_call_consent_status: "unknown",
      metadata: { voice_inbound: { identity_status: "unverified" } },
    });
    expect(lead.metadata).not.toHaveProperty("voice_identification");
    expect(state.tables.voice_call_deliveries).toEqual([expect.objectContaining({
      // Provider initiated is normalized to the active local ringing status.
      id: result.delivery!.id, site_id: SITE, recipient_phone: PHONE, status: "ringing",
      conversation_id: result.delivery!.conversation_id, lead_id: lead.id, ended_at: null,
    })]);
    expect(state.tables.conversations[0].lead_id).toBe(lead.id);
    expect(state.tables.messages[0].lead_id).toBe(lead.id);
    expect(transport).not.toHaveBeenCalled();
    return result.delivery!;
  }

  it("requests pending human assistance with unknown IDs after identification fails during an initiated call", async () => {
    const delivery = await initiate();
    const provisional = structuredClone(state.tables.leads);
    const failed = await POST(request("IDENTIFY_LEAD", { ...identity, email: "not an email" }));
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({ code: "VOICE_LEAD_INVALID_DETAILS", invalid_fields: ["email"] });
    expect(state.tables.leads).toEqual(provisional);
    expect(transport).not.toHaveBeenCalled();

    // The actual .in/.is/site/phone filters must exclude every tempting decoy.
    state.tables.voice_call_deliveries.unshift(
      { ...delivery, id: randomUUID(), status: "completed", ended_at: null },
      { ...delivery, id: randomUUID(), status: "answered", ended_at: "2026-10-01T12:00:00Z" },
      { ...delivery, id: randomUUID(), site_id: OTHER_SITE, ended_at: null },
      { ...delivery, id: randomUUID(), recipient_phone: "+13015550199", ended_at: null },
    );
    const interventionId = randomUUID();
    transport.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://backend.example.test/api/agents/tools/contact-human");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        summary: assistance.summary, message: assistance.message, priority: assistance.priority,
        conversation_id: delivery.conversation_id, voice_call_delivery_id: delivery.id,
      });
      return json({ success: true, data: { intervention_id: interventionId, staff_email: "staff@example.test" } });
    });
    const response = await POST(request("CONTACT_HUMAN", assistance));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true, status: "pending", conversation_id: delivery.conversation_id, intervention_id: interventionId,
    });
    expect(body.message).toContain("not a live transfer or a confirmed callback");
    expect(JSON.stringify(body)).not.toContain("staff@example.test");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(state.tables.leads).toEqual(provisional);
  });

  it.each(["unsigned", "tampered"])("rejects %s tools without identification, scheduling or notifications", async authentication => {
    await initiate();
    const snapshot = structuredClone(state.tables);
    state.operations.length = 0;
    for (const [tool, args] of [["IDENTIFY_LEAD", identity], ["CONTACT_HUMAN", assistance], ["scheduling", booking]] as const) {
      const req = request(tool, args, authentication);
      const signature = req.headers.get("x-zavu-signature");
      const response = await POST(req);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toMatchObject({ code: "VOICE_TOOL_AUTH_FAILED" });
      expect(body.success).not.toBe(true);
      const output = JSON.stringify([body, (console.warn as jest.Mock).mock.calls, (console.info as jest.Mock).mock.calls]);
      for (const sensitive of [mockSecret, encryptedSecret, identity.email, PHONE, process.env.SERVICE_API_KEY!, ...(signature ? [signature] : [])]) {
        expect(output).not.toContain(sensitive);
      }
    }
    expect(state.tables).toEqual(snapshot);
    expect(state.operations.every(op => op.table === "agents" && op.kind === "read")).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });

  it("saves consented identity with null optional details, then lists and schedules only for that caller/site", async () => {
    await initiate();
    const lead = state.tables.leads[0];
    lead.do_not_call = true; // An existing opt-out must survive contact-storage consent.
    const foreignLead = { id: randomUUID(), site_id: OTHER_SITE, phone: PHONE, email: identity.email };
    const otherCaller = { id: randomUUID(), site_id: SITE, phone: "+13015550199", email: "adaXcaller@example.test" };
    state.tables.leads.push(foreignLead, otherCaller);
    const foreignSnapshot = structuredClone([foreignLead, otherCaller]);

    const noConsent = await POST(request("IDENTIFY_LEAD", { ...identity, consent: false }));
    expect(noConsent.status).toBe(422);
    expect(await noConsent.json()).toMatchObject({ code: "VOICE_LEAD_CONSENT_REQUIRED" });
    expect(lead.email).toBeNull();

    const identified = await POST(request("IDENTIFY_LEAD", identity));
    const identifiedBody = await identified.json();
    expect({ status: identified.status, body: identifiedBody }).toMatchObject({ status: 200, body: { success: true } });
    expect(identifiedBody).toMatchObject({ success: true, lead_id: lead.id, is_new_lead: false, contact_details_saved: true });
    expect(lead).toMatchObject({
      name: identity.name, email: identity.email, phone: PHONE, company: {}, do_not_call: true,
      voice_call_consent_status: "unknown",
      metadata: {
        voice_inbound: { identity_status: "unverified" },
        voice_identification: { consent: true, consent_scope: "store_contact_details_and_be_contacted", identity_status: "caller_confirmed" },
      },
    });
    expect(lead.metadata.voice_identification).not.toHaveProperty("callback_phone");
    expect(state.tables.leads.slice(1)).toEqual(foreignSnapshot);
    expect(transport).not.toHaveBeenCalled();
    const writes = () => state.operations.filter(op => op.table === "leads" && op.kind === "update");
    expect(writes()).toHaveLength(1);
    const retry = await POST(request("IDENTIFY_LEAD", identity));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ contact_details_saved: true, lead_id: lead.id });
    expect(writes()).toHaveLength(1);

    const actions: string[] = [];
    transport.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://backend.example.test/api/agents/tools/scheduling/schedule");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ site_id: SITE, context_id: identifiedBody.lead_id });
      expect(body.context_id).not.toBe(foreignLead.id);
      actions.push(body.action);
      if (body.action === "list") return json({ success: true, appointments: [] });
      expect(body).toMatchObject({ action: "schedule", lead_id: lead.id, title: booking.title, duration: 30 });
      for (const optional of ["location", "description", "participants"]) expect(body).not.toHaveProperty(optional);
      return json({ success: true, appointment_id: randomUUID() });
    });
    const listed = await POST(request("scheduling", { action: "list", lead_id: identifiedBody.lead_id, context_id: null }));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ success: true, appointments: [] });
    // Even a stale model-supplied foreign alias cannot override the signed caller.
    const scheduled = await POST(request("scheduling", { ...booking, lead_id: identifiedBody.lead_id, context_id: foreignLead.id }));
    expect(scheduled.status).toBe(200);
    expect(await scheduled.json()).toMatchObject({ success: true, appointment_id: expect.any(String) });
    expect(actions).toEqual(["list", "schedule"]);
    expect(state.tables.leads.slice(1)).toEqual(foreignSnapshot);
  });

  it.each([false, undefined])("does not claim human assistance when the backend success is %s", async success => {
    await initiate();
    transport.mockImplementation(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://backend.example.test/api/agents/tools/contact-human");
      return json({ success });
    });
    const response = await POST(request("CONTACT_HUMAN", assistance));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("fails closed for multiple active calls and rejects extra model-controlled delivery scope", async () => {
    const delivery = await initiate();
    const badScope = await POST(request("CONTACT_HUMAN", { ...assistance, voice_call_delivery_id: randomUUID() }));
    expect(badScope.status).toBe(422);
    state.tables.voice_call_deliveries.push({ ...delivery, id: randomUUID(), zavu_call_id: "another-call", ended_at: null });
    const ambiguous = await POST(request("CONTACT_HUMAN", assistance));
    expect(ambiguous.status).toBe(422);
    expect(await ambiguous.json()).toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
    expect(transport).not.toHaveBeenCalled();
  });
});