const mockFrom = jest.fn();
const mockGetVoiceCall = jest.fn();
const mockBuildFollowUpContext = jest.fn();
const mockSetContactContext = jest.fn();
const mockClearContactContext = jest.fn();
const mockEnsureContactMetadata = jest.fn();
const mockFindLead = jest.fn();
const mockResolveLead = jest.fn();
const mockLinkLead = jest.fn();

jest.mock("../inbound-voice-lead", () => ({
  InboundVoiceLeadAmbiguityError: jest.requireActual("../inbound-voice-lead").InboundVoiceLeadAmbiguityError,
  findInboundVoiceLead: (...args: unknown[]) => mockFindLead(...args),
  resolveInboundVoiceLead: (...args: unknown[]) => mockResolveLead(...args),
  linkInboundVoiceLead: (...args: unknown[]) => mockLinkLead(...args),
}));

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    from: mockFrom,
    schema: jest.fn(() => ({ from: mockFrom })),
  },
}));
jest.mock("../voice-call-client", () => ({
  getVoiceCall: mockGetVoiceCall,
}));
jest.mock("../voice-follow-up-context", () => ({
  buildVoiceFollowUpContext: mockBuildFollowUpContext,
}));
jest.mock("../contact-client", () => ({
  setVoiceCallContactContext: mockSetContactContext,
  clearVoiceCallContactContext: mockClearContactContext,
}));
jest.mock("../voice-agent-context", () => ({
  ensureVoiceContactMetadataEnabled: mockEnsureContactMetadata,
}));
import { v5 as uuidv5 } from "uuid";
import { handleUntrackedInboundVoiceEvent } from "../inbound-voice-context";
import { handleVoiceCallEvent } from "../voice-webhook-handler";
import { InboundVoiceLeadAmbiguityError } from "../inbound-voice-lead";
import { MAX_VOICE_PHONE_CANDIDATES } from "../voice-phone-match";
import { inboundDatabase, SITE, OWNER } from "./inbound-lead-test-database";

function readChain(data: unknown) {
  const chain: any = {
    select: jest.fn(),
    contains: jest.fn(),
    eq: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error: null }),
  };
  chain.select.mockReturnValue(chain);
  chain.contains.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

function persistenceDatabase(siteId = "site-1", userId = "user-1") {
  const records: Record<string, Map<string, any>> = {
    conversations: new Map(), messages: new Map(), voice_call_deliveries: new Map(),
  };
  const upserts = Object.fromEntries(Object.entries(records).map(([table, rows]) => [
    table,
    jest.fn(async (payload, options): Promise<{ error: { message: string } | null }> => {
      for (const row of Array.isArray(payload) ? payload : [payload]) {
        if (!rows.has(row.id) || !options?.ignoreDuplicates) rows.set(row.id, row);
      }
      return { error: null };
    }),
  ]));
  const from = (table: string) => {
    if (table === "settings") return readChain({ site_id: siteId });
    if (table === "sites") return readChain({ id: siteId, user_id: userId, archived_at: null });
    if (table === "agents") return readChain({ id: "local-agent-1" });
    if (records[table]) return {
      upsert: upserts[table],
      update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    };
    throw new Error(`Unexpected table ${table}`);
  };
  mockFrom.mockImplementation(from);
  return { records, upserts, from };
}

function ambiguousLeads(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: uuidv5(`ambiguous-inbound-context:${i}`, uuidv5.URL), site_id: SITE,
    phone: i % 2 ? "+1 (415) 555-0100" : "+14155550100",
    name: `Existing profile ${i}`, email: `caller-${i}@example.test`,
    voice_call_consent_status: "denied", do_not_call: true,
  }));
}

describe("inbound Voice follow-up context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetVoiceCall.mockResolvedValue({
      id: "call-1",
      direction: "inbound",
      from: "+14155550100",
      to: "+14155550999",
      status: "initiated",
      createdAt: "2026-09-23T12:00:00.000Z",
    });
    mockBuildFollowUpContext.mockResolvedValue({
      context: "Known customer and recent interaction snapshot.",
      leadId: "lead-1",
      sources: { leadFound: true, messageCount: 3, transcriptCount: 1 },
    });
    mockSetContactContext.mockResolvedValue(undefined);
    mockClearContactContext.mockResolvedValue(undefined);
    mockEnsureContactMetadata.mockResolvedValue(undefined);
    mockFindLead.mockResolvedValue("lead-1");
    mockResolveLead.mockResolvedValue("lead-1");
    mockLinkLead.mockResolvedValue(undefined);
  });

  it.each([
    ["call.initiated", "initiated", "ringing"],
    ["call.answered", "answered", "in_progress"],
  ])("persists linked context before optional guidance on %s", async (eventType, providerStatus, status) => {
    const { upserts } = persistenceDatabase();
    mockGetVoiceCall.mockResolvedValueOnce({
      id: "call-1", direction: "inbound", from: "+1 (415) 555-0100", to: "+14155550999",
      status: providerStatus, createdAt: "2026-09-23T12:00:00.000Z",
    });

    const result = await handleUntrackedInboundVoiceEvent({
      type: eventType,
      senderId: "sender-1",
      data: { callId: "call-1" },
    }, "call-1");

    expect(result).toMatchObject({ handled: true, delivery: {
      site_id: "site-1", lead_id: "lead-1", zavu_call_id: "call-1",
      zavu_sender_id: "sender-1", recipient_phone: "+14155550100", status,
    } });
    const conversationId = uuidv5("inbound-voice-conversation:site-1:call-1", uuidv5.URL);
    const messageId = uuidv5("inbound-voice-message:site-1:call-1", uuidv5.URL);
    const deliveryId = uuidv5("inbound-voice-delivery:site-1:call-1", uuidv5.URL);
    expect(result.delivery).toMatchObject({ id: deliveryId, message_id: messageId, conversation_id: conversationId });
    expect(upserts.conversations).toHaveBeenCalledWith(expect.objectContaining({
      id: conversationId, site_id: "site-1", lead_id: "lead-1", channel: "voice",
      custom_data: expect.objectContaining({ call_direction: "inbound", provider_call_id: "call-1" }),
    }), { onConflict: "id", ignoreDuplicates: true });
    expect(upserts.messages).toHaveBeenCalledWith(expect.objectContaining({
      id: messageId, conversation_id: conversationId, lead_id: "lead-1", role: "system",
      custom_data: expect.objectContaining({ voice_call_delivery_id: deliveryId }),
    }), { onConflict: "id", ignoreDuplicates: true });
    expect(upserts.voice_call_deliveries).toHaveBeenCalledWith(expect.objectContaining({
      id: deliveryId, message_id: messageId, conversation_id: conversationId, status, lead_id: "lead-1",
    }), { onConflict: "id", ignoreDuplicates: true });
    expect(mockLinkLead).toHaveBeenCalledWith({
      siteId: "site-1", conversationId, deliveryId, callId: "call-1", leadId: "lead-1",
    });
    expect(mockLinkLead.mock.invocationCallOrder[0]).toBeLessThan(mockEnsureContactMetadata.mock.invocationCallOrder[0]);
    expect(mockBuildFollowUpContext).toHaveBeenCalledWith({
      siteId: "site-1",
      leadId: "lead-1",
      phone: "+14155550100",
    });
    expect(mockResolveLead).toHaveBeenCalledWith("site-1", "+14155550100");
    expect(mockFindLead).not.toHaveBeenCalled();
    expect(mockEnsureContactMetadata).toHaveBeenCalledWith("sender-1");
    expect(mockSetContactContext).toHaveBeenCalledWith({
      phone: "+14155550100",
      deliveryId: "call-1",
      siteId: "site-1",
      followUpContext: "Known customer and recent interaction snapshot.",
    });
  });

  it.each([
    ["metadata", mockEnsureContactMetadata],
    ["follow-up", mockBuildFollowUpContext],
    ["contact", mockSetContactContext],
  ])("keeps durable live context when optional %s guidance fails", async (_name, guidance) => {
    const { records } = persistenceDatabase();
    (guidance as jest.Mock).mockRejectedValueOnce(new Error("Zavu contact unavailable"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(handleUntrackedInboundVoiceEvent({
        type: "call.answered", senderId: "sender-1", data: { callId: "call-1" },
      }, "call-1")).resolves.toMatchObject({ handled: true, delivery: { lead_id: "lead-1" } });
      expect(records.conversations.size).toBe(1);
      expect(records.messages.size).toBe(1);
      expect(records.voice_call_deliveries.size).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Voice contact guidance unavailable"), expect.any(Error)
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("fails instead of accepting an inbound call with no configured site", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "settings") return readChain(null);
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(handleUntrackedInboundVoiceEvent({
      type: "call.initiated",
      senderId: "sender-missing",
      data: { callId: "call-1" },
    }, "call-1")).rejects.toThrow(
      "No site is configured for inbound Voice sender sender-missing"
    );
    expect(mockSetContactContext).not.toHaveBeenCalled();
  });

  it("creates only a provisional phone contact before identification succeeds", async () => {
    const siteId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";
    const { from, records } = persistenceDatabase(siteId, userId);
    const insert = jest.fn().mockResolvedValue({ error: null });
    mockFrom.mockImplementation((table: string) => table === "leads" ? {
      select: () => ({ eq: () => ({ ilike: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
      insert,
    } : from(table));
    const resolver = jest.requireActual("../inbound-voice-lead").resolveInboundVoiceLead;
    mockResolveLead.mockImplementationOnce(resolver);
    mockGetVoiceCall.mockResolvedValueOnce({
      id: "call-1", direction: "inbound", from: "+14155550100", to: "+14155550999",
      status: "answered", createdAt: "2026-09-23T12:00:00.000Z",
      transcript: [
        { seq: 0, role: "user", text: "My name is Pat. Email pat@example.test. I consent to future calls." },
        { seq: 1, role: "tool", text: '{"tool":"IDENTIFY_LEAD","ok":false}' },
      ],
    });

    const result = await handleUntrackedInboundVoiceEvent({
      type: "call.answered", senderId: "sender-1", data: { callId: "call-1" },
    }, "call-1");

    const leadId = uuidv5(`zavu-voice-lead:${siteId}:+14155550100`, uuidv5.URL);
    expect(insert).toHaveBeenCalledWith({
      id: leadId, site_id: siteId, user_id: userId,
      name: "Voice caller +14155550100", phone: "+14155550100", origin: "voice", status: "contacted",
      voice_call_consent_status: "unknown",
      metadata: { voice_inbound: { source: "zavu_webhook", identity_status: "unverified", phone_source: "provider_call" } },
    });
    expect(insert.mock.calls[0][0]).not.toHaveProperty("email");
    expect(insert.mock.calls[0][0]).not.toHaveProperty("voice_call_consent_at");
    expect(result.delivery?.lead_id).toBe(leadId);
    expect(records.conversations.get(result.delivery!.conversation_id).lead_id).toBe(leadId);
    expect(records.messages.get(result.delivery!.message_id).lead_id).toBe(leadId);
    expect(records.messages.size).toBe(1); // Live speech is not frozen before the final transcript.
    expect(records.voice_call_deliveries.get(result.delivery!.id).transcript).toBeNull();
  });

  it("keeps real early context linked through answered and duplicate terminal events when IDENTIFY_LEAD fails", async () => {
    const { tables } = inboundDatabase(mockFrom);
    const leadService = jest.requireActual("../inbound-voice-lead");
    mockResolveLead.mockImplementation(leadService.resolveInboundVoiceLead);
    mockLinkLead.mockImplementation(leadService.linkInboundVoiceLead);
    const event = { senderId: "sender-1", data: { callId: "call-1" } };

    await handleVoiceCallEvent({ ...event, type: "call.initiated" });
    const lead = structuredClone(tables.leads[0]);
    const deliveryId = tables.voice_call_deliveries[0].id;
    const conversationId = tables.conversations[0].id;
    const messageId = tables.messages[0].id;
    expect(lead).toMatchObject({ site_id: SITE, phone: "+14155550100", voice_call_consent_status: "unknown" });
    expect(tables.voice_call_deliveries).toEqual([expect.objectContaining({
      id: deliveryId, message_id: messageId, conversation_id: conversationId, lead_id: lead.id,
      zavu_call_id: "call-1", status: "ringing", ended_at: null,
    })]);
    await handleVoiceCallEvent({ ...event, type: "call.answered", data: { ...event.data, status: "answered" } });
    expect(tables.voice_call_deliveries[0].status).toBe("in_progress");
    expect(tables.messages).toHaveLength(1);
    expect(mockClearContactContext).not.toHaveBeenCalled();

    const transcript = [
      { seq: 0, role: "user", text: "My name is Pat, email pat@example.test. Please get a human." },
      { seq: 1, role: "tool", text: '{"tool":"IDENTIFY_LEAD","ok":false}' },
      { seq: 2, role: "assistant", text: "I will notify the team." },
    ];
    mockGetVoiceCall.mockResolvedValue({
      id: "call-1", direction: "inbound", from: "+14155550100", to: "+14155550999", status: "completed",
      createdAt: "2026-09-23T12:00:00.000Z", endedAt: "2026-09-23T12:01:00.000Z", transcript,
    });
    await handleVoiceCallEvent({ ...event, type: "call.completed" });
    await handleVoiceCallEvent({ ...event, type: "call.completed" });

    expect(tables.leads).toEqual([lead]);
    expect(tables.conversations).toEqual([expect.objectContaining({ id: conversationId, lead_id: lead.id })]);
    expect(tables.voice_call_deliveries).toEqual([expect.objectContaining({
      id: deliveryId, conversation_id: conversationId, message_id: messageId, lead_id: lead.id,
      status: "completed", transcript,
    })]);
    expect(tables.messages).toHaveLength(3);
    expect(tables.messages.every(message => message.conversation_id === conversationId && message.lead_id === lead.id)).toBe(true);
    expect(tables.messages.slice(1).map(message => message.content)).toEqual([transcript[0].text, transcript[2].text]);
    expect(mockClearContactContext).toHaveBeenLastCalledWith({ phone: "+14155550100", deliveryId: "call-1" });
  });

  it.each([
    { count: 2, terminalType: "call.completed", status: "completed" },
    { count: MAX_VOICE_PHONE_CANDIDATES + 1, terminalType: "call.failed", status: "failed" },
  ])("retains null-lead live context and final transcript through $terminalType with $count ambiguous candidates", async ({ count, terminalType, status }) => {
    const leads = ambiguousLeads(count);
    const originalLeads = structuredClone(leads);
    const { tables, operations } = inboundDatabase(mockFrom, { leads });
    mockResolveLead.mockImplementation(jest.requireActual("../inbound-voice-lead").resolveInboundVoiceLead);
    const event = { senderId: "sender-1", data: { callId: "call-1" } };

    await handleVoiceCallEvent({ ...event, type: "call.initiated" });
    await handleVoiceCallEvent({ ...event, type: "call.answered", data: { ...event.data, status: "answered" } });

    const delivery = tables.voice_call_deliveries[0];
    const conversation = tables.conversations[0];
    expect(tables.voice_call_deliveries).toEqual([expect.objectContaining({
      site_id: SITE, conversation_id: conversation.id, lead_id: null, zavu_call_id: "call-1",
      zavu_sender_id: "sender-1", recipient_phone: "+14155550100", status: "in_progress", transcript: null,
    })]);
    expect(tables.conversations).toEqual([expect.objectContaining({
      site_id: SITE, lead_id: null, channel: "voice",
      custom_data: expect.objectContaining({ call_direction: "inbound", provider_call_id: "call-1" }),
    })]);
    expect(tables.messages).toEqual([expect.objectContaining({
      id: delivery.message_id, conversation_id: conversation.id, lead_id: null, role: "system",
    })]);
    expect(mockBuildFollowUpContext).not.toHaveBeenCalled();
    expect(mockSetContactContext).toHaveBeenCalledWith({
      siteId: SITE, phone: "+14155550100", deliveryId: "call-1",
      followUpContext: "Caller identity is ambiguous. Do not use or disclose CRM profiles. Request human assistance.",
    });
    expect(mockClearContactContext).not.toHaveBeenCalled();

    const transcript = [
      { seq: 0, role: "user", text: "My name is Pat, email pat@example.test. I consent to calls. Please get a human." },
      { seq: 1, role: "tool", text: '{"tool":"IDENTIFY_LEAD","ok":false}' },
      { seq: 2, role: "assistant", text: "I will notify the team." },
    ];
    mockGetVoiceCall.mockResolvedValue({
      id: "call-1", direction: "inbound", from: "+14155550100", status,
      createdAt: "2026-09-23T12:00:00.000Z", endedAt: "2026-09-23T12:01:00.000Z", transcript,
    });
    await expect(handleVoiceCallEvent({ ...event, type: terminalType })).resolves.toBeUndefined();
    await expect(handleVoiceCallEvent({ ...event, type: terminalType })).resolves.toBeUndefined();

    expect(tables.leads).toEqual(originalLeads);
    expect(operations.filter(op => op.table === "leads").every(op => op.kind === "read")).toBe(true);
    expect(mockLinkLead).not.toHaveBeenCalled();
    expect(tables.voice_call_deliveries).toEqual([expect.objectContaining({
      id: delivery.id, conversation_id: conversation.id, message_id: delivery.message_id, lead_id: null,
      status, transcript,
    })]);
    expect(tables.conversations).toEqual([expect.objectContaining({
      id: conversation.id, lead_id: null, custom_data: expect.objectContaining({ call_status: status }),
    })]);
    expect(tables.messages).toHaveLength(3);
    expect(tables.messages.every(message => message.conversation_id === conversation.id && message.lead_id === null)).toBe(true);
    expect(tables.messages[0]).toMatchObject({ content: `Inbound Voice call ${status}.`, custom_data: { call_status: status } });
    expect(tables.messages.slice(1).map(message => message.content)).toEqual([transcript[0].text, transcript[2].text]);
    expect(mockClearContactContext).toHaveBeenLastCalledWith({ phone: "+14155550100", deliveryId: "call-1" });
  });

  it("also preserves an ambiguous call first seen at termination without selecting a lead", async () => {
    const leads = ambiguousLeads(2);
    const { tables } = inboundDatabase(mockFrom, { leads });
    mockResolveLead.mockImplementation(jest.requireActual("../inbound-voice-lead").resolveInboundVoiceLead);
    const transcript = [{ seq: 0, role: "user", text: "Please ask a human to call me back." }];
    mockGetVoiceCall.mockResolvedValue({
      id: "call-1", direction: "inbound", from: "+14155550100", status: "completed", transcript,
    });
    await expect(handleVoiceCallEvent({
      type: "call.completed", senderId: "sender-1", data: { callId: "call-1" },
    })).resolves.toBeUndefined();
    expect(tables.leads).toEqual(leads);
    expect(tables.conversations[0].lead_id).toBeNull();
    expect(tables.voice_call_deliveries[0]).toMatchObject({ lead_id: null, status: "completed", transcript });
    expect(tables.messages).toHaveLength(2);
    expect(tables.messages[1]).toMatchObject({ lead_id: null, role: "user", content: transcript[0].text });
    expect(mockLinkLead).not.toHaveBeenCalled();
    expect(mockBuildFollowUpContext).not.toHaveBeenCalled();
  });

  it.each(["lookup", "site-lookup", "site-owner", "ambiguous-site-owner", "archived-site", "missing-site", "phone", "untyped-ambiguity"])(
    "does not swallow %s errors or persist early call context", async failure => {
      const state = inboundDatabase(mockFrom);
      mockResolveLead.mockImplementation(jest.requireActual("../inbound-voice-lead").resolveInboundVoiceLead);
      if (failure === "lookup" || failure === "site-owner") {
        state.failNextTable = failure === "lookup" ? "leads" : "sites";
      }
      if (failure === "site-lookup") state.failNextTable = "settings";
      if (failure === "ambiguous-site-owner") {
        state.tables.leads = ambiguousLeads(2);
        state.failNextTable = "sites";
      }
      if (failure === "archived-site") state.tables.sites = [{ id: SITE, user_id: OWNER, archived_at: "2026-01-01" }];
      if (failure === "missing-site") state.tables.settings = [];
      if (failure === "phone") mockGetVoiceCall.mockResolvedValueOnce({ id: "call-1", direction: "inbound", from: "anonymous" });
      if (failure === "untyped-ambiguity") {
        mockResolveLead.mockRejectedValueOnce(new Error("Ambiguous inbound Voice lead; human review required"));
      }
      const originalLeads = structuredClone(state.tables.leads);

      const result = handleUntrackedInboundVoiceEvent({
        type: "call.answered", senderId: "sender-1", data: { callId: "call-1" },
      }, "call-1");
      await expect(result).rejects.toBeInstanceOf(Error);
      await expect(result).rejects.not.toBeInstanceOf(InboundVoiceLeadAmbiguityError);
      expect(state.operations.every(op => op.kind === "read")).toBe(true);
      expect(state.tables.conversations).toEqual([]);
      expect(state.tables.messages).toEqual([]);
      expect(state.tables.voice_call_deliveries).toEqual([]);
      expect(state.tables.leads).toEqual(originalLeads);
      expect(mockLinkLead).not.toHaveBeenCalled();
      expect(mockSetContactContext).not.toHaveBeenCalled();
    },
  );

  it.each(["lookup", "untyped-ambiguity"])("still rejects terminal %s errors instead of acknowledging the webhook", async failure => {
    const leads = ambiguousLeads(2);
    const state = inboundDatabase(mockFrom, { leads });
    mockResolveLead.mockImplementation(jest.requireActual("../inbound-voice-lead").resolveInboundVoiceLead);
    const event = { senderId: "sender-1", data: { callId: "call-1" } };
    await handleVoiceCallEvent({ ...event, type: "call.initiated" });
    const originalMessages = structuredClone(state.tables.messages);
    if (failure === "lookup") state.failNextTable = "leads";
    else mockResolveLead.mockRejectedValueOnce(new Error("Ambiguous inbound Voice lead; human review required"));
    mockGetVoiceCall.mockResolvedValue({
      id: "call-1", direction: "inbound", from: "+14155550100", status: "completed",
      transcript: [{ seq: 0, role: "user", text: "Please get a human." }],
    });

    const result = handleVoiceCallEvent({ ...event, type: "call.completed" });
    await expect(result).rejects.toThrow(failure === "lookup"
      ? "Unable to resolve inbound Voice lead" : "Ambiguous inbound Voice lead; human review required");
    await expect(result).rejects.not.toBeInstanceOf(InboundVoiceLeadAmbiguityError);
    expect(state.tables.leads).toEqual(leads);
    expect(state.tables.messages).toEqual(originalMessages);
    expect(mockLinkLead).not.toHaveBeenCalled();
    expect(mockClearContactContext).not.toHaveBeenCalled();
  });

  it("reuses deterministic IDs and ignores duplicate early upserts without replacing terminal records", async () => {
    const { records, upserts } = persistenceDatabase();
    const event = { type: "call.initiated", senderId: "sender-1", data: { callId: "call-1" } };
    const first = await handleUntrackedInboundVoiceEvent(event, "call-1");
    const existing = records.voice_call_deliveries.get(first.delivery!.id);
    existing.status = "completed";
    existing.transcript = [{ seq: 0, role: "user", text: "Final turn" }];
    const conversation = records.conversations.get(first.delivery!.conversation_id);
    conversation.custom_data = { ...conversation.custom_data, retained: true };
    const message = records.messages.get(first.delivery!.message_id);
    message.custom_data.call_status = "completed";

    const retry = await handleUntrackedInboundVoiceEvent(event, "call-1");

    expect(retry.delivery?.id).toBe(first.delivery?.id);
    for (const [table, rows] of Object.entries(records)) {
      expect(rows.size).toBe(1);
      expect(upserts[table]).toHaveBeenNthCalledWith(2, expect.any(Object), { onConflict: "id", ignoreDuplicates: true });
    }
    expect(existing.status).toBe("completed");
    expect(existing.transcript).toEqual([{ seq: 0, role: "user", text: "Final turn" }]);
    expect(conversation.custom_data.retained).toBe(true);
    expect(message.custom_data.call_status).toBe("completed");
  });

  it("retries durable persistence failures instead of treating them as optional guidance", async () => {
    const { upserts } = persistenceDatabase();
    upserts.voice_call_deliveries.mockResolvedValueOnce({ error: { message: "DB unavailable" } });
    await expect(handleUntrackedInboundVoiceEvent({
      type: "call.answered", senderId: "sender-1", data: { callId: "call-1" },
    }, "call-1")).rejects.toThrow("Failed to persist inbound Voice delivery");
    expect(mockEnsureContactMetadata).not.toHaveBeenCalled();
    expect(mockSetContactContext).not.toHaveBeenCalled();
  });

  it("does not rehydrate a late initiation when the provider call is already terminal", async () => {
    const { records } = persistenceDatabase();
    mockGetVoiceCall.mockResolvedValueOnce({
      id: "call-1", direction: "inbound", from: "+14155550100", status: "completed",
      transcript: [{ seq: 0, role: "user", text: "Final turn" }],
    });
    const result = await handleUntrackedInboundVoiceEvent({
      type: "call.initiated", senderId: "sender-1", data: { callId: "call-1" },
    }, "call-1");
    expect(result.delivery?.status).toBe("completed");
    expect(records.messages.size).toBe(2);
    expect(mockSetContactContext).not.toHaveBeenCalled();
    expect(mockClearContactContext).toHaveBeenCalledWith({ phone: "+14155550100", deliveryId: "call-1" });
  });

  it.each([
    [{ id: "other-call" }, { senderId: "sender-1" }, "does not match the webhook"],
    [{ senderId: "other-sender" }, { senderId: "sender-1" }, "does not match the webhook sender"],
    [{}, { senderId: "sender-1", data: { call: { senderId: "other-sender" } } }, "conflicting sender IDs"],
    [{}, {}, "missing senderId"],
    [{ from: "anonymous" }, { senderId: "sender-1" }, "not valid E.164"],
  ])("rejects invalid inbound binding before persistence: %j %j", async (call, event, error) => {
    mockGetVoiceCall.mockResolvedValueOnce({
      id: "call-1", direction: "inbound", from: "+14155550100", status: "initiated", ...call,
    });
    await expect(handleUntrackedInboundVoiceEvent({ type: "call.initiated", ...event }, "call-1"))
      .rejects.toThrow(error as string);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockResolveLead).not.toHaveBeenCalled();
    expect(mockSetContactContext).not.toHaveBeenCalled();
  });

  it("stores spoken turns alongside the original Voice call without starting Customer Support", async () => {
    mockGetVoiceCall.mockResolvedValue({
      id: "call-1",
      direction: "inbound",
      from: "+14155550100",
      to: "+14155550999",
      status: "completed",
      agentId: "provider-agent-1",
      transcript: [
        { seq: 1, role: "user", text: "I need to move my appointment." },
        { seq: 2, role: "tool", text: "internal reservation payload" },
        { seq: 3, role: "assistant", text: "I can help with that." },
      ],
      createdAt: "2026-09-23T12:00:00.000Z",
      endedAt: "2026-09-23T12:02:00.000Z",
    });
    const conversationUpserts: Record<string, any>[] = [];
    const messageUpserts: Array<Record<string, any> | Array<Record<string, any>>> = [];
    const deliveryUpserts: Record<string, any>[] = [];
    mockFrom.mockImplementation((table: string) => {
      if (table === "settings") return readChain({ site_id: "site-1" });
      if (table === "leads") return readChain({ id: "lead-1" });
      if (table === "sites") return readChain({ user_id: "user-1" });
      if (table === "agents") return readChain({ id: "local-agent-1" });
      if (table === "conversations") {
        return {
          upsert: jest.fn().mockImplementation(async (payload) => {
            conversationUpserts.push(payload);
            return { error: null };
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          upsert: jest.fn().mockImplementation(async (payload) => {
            messageUpserts.push(payload);
            return { error: null };
          }),
        };
      }
      if (table === "voice_call_deliveries") {
        return {
          upsert: jest.fn().mockImplementation(async (payload) => {
            deliveryUpserts.push(payload);
            return { error: null };
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await handleUntrackedInboundVoiceEvent({
      type: "call.completed",
      senderId: "sender-1",
      data: { callId: "call-1" },
    }, "call-1");

    expect(result).toMatchObject({
      handled: true,
      delivery: {
        recipient_phone: "+14155550100",
        status: "completed",
      },
    });
    expect(conversationUpserts[0]).toMatchObject({
      channel: "voice", user_id: "user-1", agent_id: "local-agent-1",
    });
    expect(mockResolveLead).toHaveBeenCalledWith("site-1", "+14155550100");
    expect(mockLinkLead).toHaveBeenCalledWith({ siteId: "site-1", callId: "call-1", leadId: "lead-1",
      conversationId: conversationUpserts[0].id, deliveryId: deliveryUpserts[0].id,
    });
    expect(messageUpserts[0]).toMatchObject({
      conversation_id: conversationUpserts[0].id,
      role: "system",
      content: "Inbound Voice call completed.",
      custom_data: expect.objectContaining({
        source: "zavu_inbound_voice",
        voice_call_delivery_id: expect.any(String),
      }),
    });
    const speech = messageUpserts[1] as Array<Record<string, any>>;
    expect(speech.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "I need to move my appointment." },
      { role: "assistant", content: "I can help with that." },
    ]);
    expect(speech.every((turn) => turn.conversation_id === conversationUpserts[0].id))
      .toBe(true);
    expect(speech[0].custom_data).toMatchObject({
      source: "zavu_voice_transcript",
      voice_call_delivery_id: deliveryUpserts[0].id,
    });
    expect(speech[1].agent_id).toBe("local-agent-1");
    expect(speech[0]).not.toHaveProperty("agent_id");
    expect(deliveryUpserts[0]).toMatchObject({
      zavu_call_id: "call-1",
      message_id: (messageUpserts[0] as Record<string, any>).id,
      conversation_id: conversationUpserts[0].id,
      lead_id: "lead-1",
      transcript: [
        { seq: 1, role: "user", text: "I need to move my appointment." },
        { seq: 2, role: "tool", text: "internal reservation payload" },
        { seq: 3, role: "assistant", text: "I can help with that." },
      ],
    });
    expect(mockClearContactContext).toHaveBeenCalledWith({
      phone: "+14155550100",
      deliveryId: "call-1",
    });
  });
});
