import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import {
  MAX_VOICE_PHONE_CANDIDATES,
  matchesVoiceLeadPhone,
  normalizeVoiceIdentityPhone,
  voiceLeadPhoneSearchPattern,
} from "./voice-phone-match";

const uuid = z.string().uuid();
type Lead = { id: string; site_id: string; phone: string | null };

function database() {
  return supabaseAdmin.schema(
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
    || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA
    || "public"
  );
}

function scope(siteId: string, phone: string) {
  const normalized = normalizeVoiceIdentityPhone(phone);
  if (!uuid.safeParse(siteId).success || !normalized) {
    throw new Error("Invalid inbound Voice lead scope");
  }
  return { siteId: siteId.toLowerCase(), phone: normalized };
}

function assertLead(lead: Lead, siteId: string, phone: string): string {
  if (!uuid.safeParse(lead.id).success || lead.site_id !== siteId || !matchesVoiceLeadPhone(lead.phone, phone)) {
    throw new Error("Inbound Voice lead conflicts with the call scope");
  }
  return lead.id;
}

/** Match explicit CRM phone aliases within a site; never choose an arbitrary suffix match. */
export async function findInboundVoiceLead(siteId: string, phone: string): Promise<string | undefined> {
  const trusted = scope(siteId, phone);
  const pattern = voiceLeadPhoneSearchPattern(trusted.phone);
  const { data, error } = await database().from("leads")
    .select("id, site_id, phone").eq("site_id", trusted.siteId).ilike("phone", pattern).limit(MAX_VOICE_PHONE_CANDIDATES + 1);
  if (error) throw new Error("Unable to resolve inbound Voice lead");
  const candidates = (data || []) as Lead[];
  if (candidates.length > MAX_VOICE_PHONE_CANDIDATES) throw new Error("Inbound Voice lead lookup requires human review");
  const matches = candidates.filter(lead => matchesVoiceLeadPhone(lead.phone, trusted.phone));
  if (matches.length > 1) throw new Error("Ambiguous inbound Voice lead; human review required");
  return matches[0] ? assertLead(matches[0], trusted.siteId, trusted.phone) : undefined;
}

/**
 * Record a minimal inbound CRM contact after webhook authentication, not a verified identity.
 * This never runs an assistant, invents an email/name from speech, or grants outbound consent.
 */
export async function resolveInboundVoiceLead(siteId: string, phone: string): Promise<string> {
  const trusted = scope(siteId, phone);
  const existing = await findInboundVoiceLead(trusted.siteId, trusted.phone);
  if (existing) return existing;
  const db = database();
  const { data: site, error } = await db.from("sites").select("id, user_id, archived_at")
    .eq("id", trusted.siteId).maybeSingle();
  if (error || site?.id !== trusted.siteId || site.archived_at || !uuid.safeParse(site?.user_id).success) {
    throw new Error("Unable to resolve inbound Voice site owner");
  }
  // Share the native IDENTIFY_LEAD namespace so both creation paths converge on the same PK.
  const id = uuidv5(`zavu-voice-lead:${trusted.siteId}:${trusted.phone}`, uuidv5.URL);
  const { error: insertError } = await db.from("leads").insert({
    id, site_id: trusted.siteId, user_id: site.user_id,
    name: `Voice caller ${trusted.phone}`, phone: trusted.phone,
    origin: "voice", status: "contacted",
    voice_call_consent_status: "unknown",
    metadata: { voice_inbound: { source: "zavu_webhook", identity_status: "unverified", phone_source: "provider_call" } },
  });
  if (!insertError) return id;
  if (insertError.code === "23505") {
    const winner = await findInboundVoiceLead(trusted.siteId, trusted.phone);
    if (winner) return winner;
  }
  throw new Error("Unable to create inbound Voice lead");
}

type LinkInput = { siteId: string; conversationId: string; deliveryId: string; callId: string; leadId: string };

/** Null-only, retryable linkage. Existing non-null links are never reassigned. */
export async function linkInboundVoiceLead(input: LinkInput): Promise<void> {
  if (![input.siteId, input.conversationId, input.deliveryId, input.leadId].every(id => uuid.safeParse(id).success)
    || !input.callId || input.callId.length > 300) throw new Error("Invalid inbound Voice linkage scope");
  const db = database();
  const [{ data: conversation, error: conversationError }, { data: delivery, error: deliveryError }, { data: lead, error: leadError }] = await Promise.all([
    db.from("conversations").select("id, site_id, lead_id, custom_data")
      .eq("id", input.conversationId).eq("site_id", input.siteId).maybeSingle(),
    db.from("voice_call_deliveries").select("id, site_id, conversation_id, lead_id, zavu_call_id, recipient_phone")
      .eq("id", input.deliveryId).eq("site_id", input.siteId).eq("conversation_id", input.conversationId)
      .eq("zavu_call_id", input.callId).maybeSingle(),
    db.from("leads").select("id, site_id, phone").eq("id", input.leadId).eq("site_id", input.siteId).maybeSingle(),
  ]);
  if (conversationError || deliveryError || leadError) throw new Error("Unable to verify inbound Voice linkage");
  if (!conversation || !delivery || !lead || conversation.id !== input.conversationId || conversation.site_id !== input.siteId
    || delivery.id !== input.deliveryId || delivery.site_id !== input.siteId || delivery.conversation_id !== input.conversationId
    || delivery.zavu_call_id !== input.callId || conversation.custom_data?.call_direction !== "inbound"
    || conversation.custom_data?.provider_call_id !== input.callId
    || (conversation.lead_id && conversation.lead_id !== input.leadId)
    || (delivery.lead_id && delivery.lead_id !== input.leadId)) {
    throw new Error("Inbound Voice linkage conflicts with existing records");
  }
  const phone = normalizeVoiceIdentityPhone(delivery.recipient_phone);
  if (!phone || assertLead(lead as Lead, input.siteId, phone) !== input.leadId) {
    throw new Error("Inbound Voice lead conflicts with the call scope");
  }
  const checkMessages = async () => {
    const { data: conflicts, error } = await db.from("messages").select("id")
      .eq("conversation_id", input.conversationId).eq("custom_data->>provider_call_id", input.callId)
      .not("lead_id", "is", null).neq("lead_id", input.leadId).limit(1);
    if (error) throw new Error("Unable to verify inbound Voice transcript linkage");
    if (conflicts?.length) throw new Error("Inbound Voice transcript linkage conflicts with existing records");
  };
  await checkMessages();
  // Each table is independently retryable. A later failure keeps earlier correct links intact.
  for (const [table, id] of [["conversations", input.conversationId], ["voice_call_deliveries", input.deliveryId]] as const) {
    const { error } = await db.from(table).update({ lead_id: input.leadId })
      .eq("id", id).eq("site_id", input.siteId).is("lead_id", null);
    if (error) throw new Error("Unable to link inbound Voice lead");
    const { data: saved, error: readError } = await db.from(table).select("lead_id")
      .eq("id", id).eq("site_id", input.siteId).maybeSingle();
    if (readError || saved?.lead_id !== input.leadId) throw new Error("Inbound Voice linkage changed concurrently");
  }
  const { error: messagesError } = await db.from("messages").update({ lead_id: input.leadId })
    .eq("conversation_id", input.conversationId).eq("custom_data->>provider_call_id", input.callId).is("lead_id", null);
  if (messagesError) throw new Error("Unable to link inbound Voice transcript");
  await checkMessages();
}