import { getLeadById } from "@/lib/database/lead-db";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { placeTrackedVoiceCall } from "@/lib/services/zavu/voice-call-service";
import { placeVoiceCallTool } from "../assistantProtocol";
import { randomBytes, randomUUID } from 'node:crypto';
import { buildToolExecutionContext } from '@/lib/services/tool-execution-context';

jest.mock("@/lib/database/lead-db", () => ({
  getLeadById: jest.fn(),
}));
jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/lib/services/zavu/voice-call-service", () => ({
  placeTrackedVoiceCall: jest.fn(),
}));

const SITE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const LEAD_ID = "cccccccc-dddd-4eee-8fff-000000000000";

describe("placeVoiceCallTool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLeadById as jest.Mock).mockResolvedValue({
      id: LEAD_ID,
      site_id: SITE_ID,
      phone: "+52 1555 123 4567",
    });
    (supabaseAdmin.from as jest.Mock).mockImplementation(() => ({
      upsert: jest.fn().mockResolvedValue({ error: null }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      }),
    }));
    (placeTrackedVoiceCall as jest.Mock).mockResolvedValue({
      deliveryId: "delivery-1",
      duplicate: false,
      call: { id: "call-1", status: "queued" },
    });
  });

  it("creates records and places a site-scoped call with private context", async () => {
    const result = await placeVoiceCallTool(SITE_ID, USER_ID).execute({
      lead_id: LEAD_ID,
      idempotency_key: "appointment-2026-09-24",
      greeting: "Hello, this is Acme.",
      objective: "Confirm tomorrow's appointment",
      additional_context: "The appointment starts at 10 AM.",
      language: "en-US",
      max_duration_minutes: 5,
    });

    expect(result).toMatchObject({
      success: true,
      call_id: "call-1",
      delivery_id: "delivery-1",
    });
    expect(placeTrackedVoiceCall).toHaveBeenCalledWith(expect.objectContaining({
      siteId: SITE_ID,
      to: "+5215551234567",
      leadId: LEAD_ID,
      greeting: "Hello, this is Acme.",
      objective: "Confirm tomorrow's appointment",
      additionalContext: "The appointment starts at 10 AM.",
      language: "en-US",
      maxDurationMinutes: 5,
    }));
  });

  it("rejects a lead from another site before creating records", async () => {
    (getLeadById as jest.Mock).mockResolvedValueOnce({
      id: LEAD_ID,
      site_id: "dddddddd-eeee-4fff-8000-111111111111",
      phone: "+5215551234567",
    });

    await expect(
      placeVoiceCallTool(SITE_ID).execute({
        lead_id: LEAD_ID,
        idempotency_key: "appointment-2026-09-24",
        greeting: "Hello.",
        objective: "Confirm the appointment",
      })
    ).rejects.toThrow("Lead was not found in this site");

    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(placeTrackedVoiceCall).not.toHaveBeenCalled();
  });

  it("reuses deterministic records when the same call is retried", async () => {
    const tool = placeVoiceCallTool(SITE_ID, USER_ID);
    const args = {
      lead_id: LEAD_ID,
      idempotency_key: "appointment-2026-09-24",
      greeting: "Hello, this is Acme.",
      objective: "Confirm the appointment",
    };

    await tool.execute(args);
    await tool.execute(args);

    const first = (placeTrackedVoiceCall as jest.Mock).mock.calls[0][0];
    const second = (placeTrackedVoiceCall as jest.Mock).mock.calls[1][0];
    expect(second.messageId).toBe(first.messageId);
    expect(second.conversationId).toBe(first.conversationId);
  });

  it('persists inherited intent privately without forwarding it through the 500-character objective argument', async () => {
    const password = randomBytes(24).toString('hex');
    const url = new URL('https://example.invalid/context');
    const username = randomBytes(18).toString('hex');
    url.username = username;
    url.password = password;
    const context = buildToolExecutionContext({ site_id: SITE_ID,
      intent: 'Confirm availability. '.repeat(80), background: `Reference ${url.href}`,
      source: { node_id: randomUUID(), conversation_id: randomUUID() } })!;
    const result = await placeVoiceCallTool(SITE_ID).execute({ lead_id: LEAD_ID,
      idempotency_key: 'offline-call-context', greeting: 'Hello from Acme.' }, context);
    const rows = (supabaseAdmin.from as jest.Mock).mock.results.map(result => result.value.upsert.mock.calls[0][0]);
    const message = rows[1];
    expect(message.custom_data.tool_execution_context).toMatchObject({ ...context, source: { ...context.source, tool: 'placeVoiceCall' } });
    expect(message.custom_data).not.toHaveProperty('voice_objective');
    expect(message.content).toBe('Hello from Acme.');
    const placement = (placeTrackedVoiceCall as jest.Mock).mock.calls[0][0];
    expect(placement.objective).toBeUndefined();
    expect(placement.additionalContext).toBeUndefined();
    expect(placement.conversationId).not.toBe(context.source.conversation_id);
    expect(getLeadById).toHaveBeenCalledWith(LEAD_ID);
    for (const value of [username, password]) expect(JSON.stringify(rows)).not.toContain(value);
    expect(JSON.stringify(result)).not.toContain(context.intent);
    expect(JSON.stringify(placement)).not.toContain(context.intent);
    expect(JSON.stringify(result)).not.toContain('tool_execution_context');
  });

  it('explicit objective wins over inherited intent in the stored envelope', async () => {
    const context = buildToolExecutionContext({ site_id: SITE_ID, intent: 'Fallback', background: 'Inherited facts' });
    await placeVoiceCallTool(SITE_ID).execute({ lead_id: LEAD_ID, idempotency_key: 'offline-call-context',
      greeting: 'Hello.', objective: 'Confirm Monday', additional_context: 'Explicit facts' }, context);
    const message = (supabaseAdmin.from as jest.Mock).mock.results[1].value.upsert.mock.calls[0][0];
    expect(message.custom_data.tool_execution_context).toMatchObject({ intent: 'Confirm Monday', background: 'Explicit facts' });
  });

  it('foreign contexts cannot supply the required purpose or authorize another lead', async () => {
    const foreign = buildToolExecutionContext({ site_id: randomUUID(), intent: 'Foreign purpose', source: { conversation_id: randomUUID() } });
    await expect(placeVoiceCallTool(SITE_ID).execute({ lead_id: LEAD_ID, idempotency_key: 'offline-call-context', greeting: 'Hello.' }, foreign))
      .rejects.toThrow('objective are required');
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(getLeadById).not.toHaveBeenCalled();
  });

  it('retains the explicit objective length limit even with a valid envelope', async () => {
    const context = buildToolExecutionContext({ site_id: SITE_ID, intent: 'Fallback' });
    await expect(placeVoiceCallTool(SITE_ID).execute({ lead_id: LEAD_ID, idempotency_key: 'offline-call-context',
      greeting: 'Hello.', objective: 'o'.repeat(501) }, context)).rejects.toThrow('500');
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('does not leave explicit credentials in legacy guidance fields or the conversation title', async () => {
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    await placeVoiceCallTool(SITE_ID).execute({ lead_id: LEAD_ID, idempotency_key: 'offline-call-context',
      greeting: 'Hello.', objective: `Confirm availability. password=${password}`,
      additional_context: `Verify calendar. Bearer ${token}` });
    const rows = (supabaseAdmin.from as jest.Mock).mock.results.map(result => result.value.upsert.mock.calls[0][0]);
    for (const secret of [password, token]) {
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect(JSON.stringify((placeTrackedVoiceCall as jest.Mock).mock.calls)).not.toContain(secret);
    }
    expect(rows[1].custom_data.voice_objective).toContain('[REDACTED]');
    expect(rows[1].custom_data.voice_additional_context).toContain('[REDACTED]');
  });
});
