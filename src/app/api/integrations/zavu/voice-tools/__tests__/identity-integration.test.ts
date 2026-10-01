import { createHmac } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { v5 as uuidv5 } from "uuid";

let mockClient: SupabaseClient;
jest.mock("@/lib/database/supabase-server", () => ({
  getSupabaseAdmin: () => mockClient,
  supabaseAdmin: { schema: (schema: string) => mockClient.schema(schema) },
}));
jest.mock("@/lib/utils/token-decryption", () => ({ decryptToken: () => "test-only-secret" }));
jest.mock("@/lib/services/zavu/voice-tool-catalog", () => ({
  getCustomerSupportVoiceToolDefinitions: () => [{ name: "IDENTIFY_LEAD", parameters: {} }],
}));
jest.mock("@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap", () => ({
  getCustomToolDefinition: jest.fn(() => { throw new Error("Browser tools must not execute"); }),
}));

import { POST } from "../route";

const SITE = "11111111-1111-4111-8111-111111111111";
const PHONE = "+13015550100";
const LEAD = uuidv5(`zavu-voice-lead:${SITE}:${PHONE}`, uuidv5.URL);

function request(args: Record<string, unknown>, signed = true) {
  const body = JSON.stringify({
    tool: "IDENTIFY_LEAD", arguments: args, context: { contactPhone: PHONE },
  });
  return new NextRequest(`https://api.example.test/api/integrations/zavu/voice-tools?siteId=${SITE}`, {
    method: "POST", body,
    headers: {
      "content-type": "application/json",
      ...(signed ? { "x-zavu-signature": createHmac("sha256", "test-only-secret").update(body).digest("hex") } : {}),
    },
  });
}

describe("signed Voice identity callback with real executor and PostgREST serialization", () => {
  let transport: jest.Mock;
  let stored: Record<string, any>;
  let writes: Array<{ url: URL; body: Record<string, any> }>;

  beforeEach(() => {
    stored = {
      id: LEAD, site_id: SITE, phone: PHONE, email: null, company: {},
      name: `Voice caller ${PHONE}`, origin: "voice", do_not_call: true,
      metadata: { voice_inbound: { source: "zavu_webhook", identity_status: "unverified", phone_source: "provider_call" } },
    };
    writes = [];
    transport = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname.endsWith("/agents")) {
        return json({ configuration: { zavu: { tool_webhook_secret: "encrypted-test-secret" } } });
      }
      expect(url.pathname).toBe("/rest/v1/leads");
      expect(url.searchParams.get("site_id")).toBe(`eq.${SITE}`);
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        // Assert the real supabase-js wire format, not only a mocked query chain.
        expect(url.searchParams.get("id")).toBe(`eq.${LEAD}`);
        expect(url.searchParams.get("phone")).toBe(`eq.${PHONE}`);
        expect(url.searchParams.get("name")).toBe(`eq.${stored.name}`);
        expect(url.searchParams.get("email")).toBe("is.null");
        expect(url.searchParams.get("company")).toBe(`eq.${JSON.stringify(stored.company)}`);
        expect(url.searchParams.get("metadata")).toBe(`eq.${JSON.stringify(stored.metadata)}`);
        writes.push({ url, body });
        stored = { ...stored, ...body };
        return json({ id: LEAD });
      }
      expect(init?.method).toBe("GET");
      const email = url.searchParams.get("email");
      return json(email ? (stored.email ? [stored] : []) : [stored]);
    });
    mockClient = createClient("https://offline.example.test", "test-only-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport },
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("authenticates, normalizes dictation, completes the placeholder, and makes retries idempotent", async () => {
    const args = {
      name: "Ada Caller", email: "Ada punto Caller arroba m e punto com.",
      callback_phone: "+1 (415) 555-0199", consent: true,
    };
    const first = await POST(request(args));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ lead_id: LEAD, contact_details_saved: true });
    expect(stored).toMatchObject({
      phone: PHONE, email: "ada.caller@me.com", name: "Ada Caller", do_not_call: true,
      metadata: { voice_identification: { callback_phone: "+14155550199", callback_phone_verified: false } },
    });
    const retry = await POST(request(args));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ lead_id: LEAD, contact_details_saved: true });
    expect(writes).toHaveLength(1);
    expect(writes[0].body).not.toHaveProperty("phone");
    expect(writes[0].body).not.toHaveProperty("do_not_call");
  });

  it("returns only the failing fields through the real validation path without writing", async () => {
    const response = await POST(request({ name: "Ada Caller", email: "ada@example.com", company: {}, consent: true }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ code: "VOICE_LEAD_INVALID_DETAILS", invalid_fields: ["company"] });
    expect(body.error).not.toContain("email:");
    expect(writes).toHaveLength(0);
    expect(transport).toHaveBeenCalledTimes(1); // Auth configuration only, no identity lookup.
  });

  it("rejects unsigned requests before identification or persistence", async () => {
    const response = await POST(request({ name: "Ada Caller", email: "ada@example.com", consent: true }, false));
    expect(response.status).toBe(401);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(stored.email).toBeNull();
    expect(writes).toHaveLength(0);
  });
});