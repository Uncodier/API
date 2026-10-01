import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { normalizeVoiceIdentityEmail } from "./voice-identity-email";
import { VoiceLeadValidationError, type VoiceLeadField } from "./voice-lead-errors";
import {
  MAX_VOICE_PHONE_CANDIDATES,
  matchesVoiceLeadPhone,
  normalizeVoiceIdentityPhone,
  voiceLeadPhoneSearchPattern,
} from "./voice-phone-match";

export { normalizeVoiceIdentityPhone } from "./voice-phone-match";

const identitySchema = z.object({
  name: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
  email: z.preprocess(normalizeVoiceIdentityEmail, z.string().max(254).email()),
  phone: z.string().trim().min(1).max(80).optional(),
  callback_phone: z.string().trim().min(1).max(80).optional(),
  company: z.string().trim().max(200).optional(),
});

type ConfirmedIdentity = z.infer<typeof identitySchema>;
type LeadIdentity = {
  id: string;
  site_id: string;
  email: string | null;
  phone: string | null;
  name: string;
  origin: string | null;
  company: { name?: string } | null;
  metadata: Record<string, any> | null;
};

export type VoiceLeadIdentificationResult = {
  success: true;
  lead_id: string;
  is_new_lead: boolean;
  contact_details_saved: boolean;
  message?: string;
};

function tenantDatabase() {
  return supabaseAdmin.schema(
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
    || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA
    || "public"
  );
}

function conflict(): never {
  // Deliberately do not reveal which other profile/contact detail matched.
  throw new Error("Voice lead identity conflicts with existing records; request human assistance");
}

async function findExistingLead(
  siteId: string,
  phone: string,
  email: string
): Promise<LeadIdentity | undefined> {
  const db = tenantDatabase();
  // Separate filters avoid an email OR phone / limit(1) arbitrary identity merge.
  // Escape LIKE metacharacters: a literal '_' or '%' in an email is not a wildcard.
  const emailPattern = email.replace(/[\\%_]/g, "\\$&");
  const [phoneResult, emailResult] = await Promise.all([
    db.from("leads")
      .select("id, site_id, email, phone, name, origin, company, metadata")
      .eq("site_id", siteId)
      .ilike("phone", voiceLeadPhoneSearchPattern(phone))
      .limit(MAX_VOICE_PHONE_CANDIDATES + 1),
    db.from("leads")
      .select("id, site_id, email, phone, name, origin, company, metadata")
      .eq("site_id", siteId)
      .ilike("email", emailPattern)
      .limit(2),
  ]);
  if (phoneResult.error || emailResult.error) {
    throw new Error("Unable to check existing Voice lead identity");
  }
  const phoneCandidates = (phoneResult.data || []) as LeadIdentity[];
  if (phoneCandidates.length > MAX_VOICE_PHONE_CANDIDATES) conflict();
  const phoneMatches = phoneCandidates.filter(lead => matchesVoiceLeadPhone(lead.phone, phone));
  const emailMatches = (emailResult.data || []) as LeadIdentity[];
  if (phoneMatches.length > 1 || emailMatches.length > 1) conflict();
  const phoneLead = phoneMatches[0];
  const emailLead = emailMatches[0];

  // Email is caller-supplied, not proof of ownership. It cannot bind a different
  // phone's (or an email-only) profile to this caller, even with consent.
  if (emailLead && (!phoneLead || emailLead.id !== phoneLead.id)) conflict();
  if (!phoneLead) return undefined;
  if (
    phoneLead.site_id !== siteId
    || !matchesVoiceLeadPhone(phoneLead.phone, phone)
    || !z.string().uuid().safeParse(phoneLead.id).success
    || (phoneLead.email?.trim() && phoneLead.email.trim().toLowerCase() !== email)
  ) conflict();
  return phoneLead;
}

function identificationMetadata(callbackPhone?: string) {
  return {
    consent: true,
    consent_scope: "store_contact_details_and_be_contacted",
    consent_recorded_at: new Date().toISOString(),
    // Caller-supplied contact details are not verified identity or call consent.
    identity_status: "caller_confirmed",
    ...(callbackPhone ? { callback_phone: callbackPhone, callback_phone_verified: false } : {}),
  };
}

function isProvisionalLead(lead: LeadIdentity): boolean {
  const inbound = lead.metadata?.voice_inbound;
  return lead.id === uuidv5(`zavu-voice-lead:${lead.site_id}:${lead.phone}`, uuidv5.URL)
    && lead.origin === "voice"
    && lead.name === `Voice caller ${lead.phone}`
    && lead.email === null
    && (lead.company == null || (
      typeof lead.company === "object" && !Array.isArray(lead.company) && Object.keys(lead.company).length === 0
    ))
    && inbound?.source === "zavu_webhook"
    && inbound.identity_status === "unverified"
    && inbound.phone_source === "provider_call"
    && lead.metadata?.voice_identification == null;
}

function existingResult(lead: LeadIdentity, identity: ConfirmedIdentity): VoiceLeadIdentificationResult {
  const saved = lead.email?.trim().toLowerCase() === identity.email
    && lead.name === identity.name
    && (!identity.company || lead.company?.name === identity.company)
    && (!identity.callback_phone || lead.metadata?.voice_identification?.callback_phone === identity.callback_phone);
  return {
    success: true, lead_id: lead.id, is_new_lead: false, contact_details_saved: saved,
    ...(!saved ? {
      message: "Caller matched, but existing contact details were not changed. Do not claim the new details were saved; request human assistance to update this profile.",
    } : {}),
  };
}

async function completeProvisionalLead(
  lead: LeadIdentity,
  identity: ConfirmedIdentity
): Promise<VoiceLeadIdentificationResult> {
  if (!isProvisionalLead(lead)) return existingResult(lead, identity);

  // Only upgrade our own empty webhook placeholder. Compare the complete
  // metadata snapshot so concurrent changes and opt-outs are never overwritten.
  let update = tenantDatabase().from("leads").update({
    name: identity.name,
    email: identity.email,
    ...(identity.company ? { company: { name: identity.company } } : {}),
    metadata: { ...lead.metadata, voice_identification: identificationMetadata(identity.callback_phone) },
  }).eq("id", lead.id).eq("site_id", lead.site_id).eq("phone", lead.phone)
    .eq("origin", "voice").eq("name", lead.name).is("email", null)
    .eq("metadata", JSON.stringify(lead.metadata));
  // The live schema defaults company to {}, while older placeholders can be null.
  update = lead.company == null ? update.is("company", null) : update.eq("company", JSON.stringify(lead.company));
  const { error } = await update.select("id").maybeSingle();
  if (error) throw new Error("Unable to save confirmed Voice contact details");
  // Check both the saved details and identity conflicts again before success,
  // including a simultaneous winner. This is not a cross-row uniqueness lock.
  const winner = await findExistingLead(lead.site_id, lead.phone!, identity.email);
  if (winner?.id === lead.id && !isProvisionalLead(winner)) return existingResult(winner, identity);
  throw new Error("Voice contact changed during confirmation; retry with the same confirmed details");
}

/**
 * Native live-call adapter. The caller has no browser visitor or conversation
 * yet. siteId and contactPhone must come from the authenticated voice boundary,
 * never tool arguments. This records contact consent, not outbound-call consent.
 *
 * The general lead service is intentionally not used: its OR/limit(1) matching,
 * optional tenant and random insert IDs cannot safely implement this contract.
 */
export async function identifyVoiceLead(params: {
  siteId: string;
  contactPhone?: string;
  arguments: Record<string, unknown>;
}): Promise<VoiceLeadIdentificationResult> {
  if (params.arguments?.consent !== true) {
    throw new VoiceLeadValidationError("VOICE_LEAD_CONSENT_REQUIRED", ["consent"]);
  }
  if (!z.string().uuid().safeParse(params.siteId).success) {
    throw new Error("A valid authoritative site is required for Voice lead identification");
  }
  // Zod strips unknown fields: never forward site/user/lead/visitor IDs, metadata,
  // conversation, command_id, or any other model-controlled persistence fields.
  const parsed = identitySchema.safeParse(params.arguments);
  if (!parsed.success) {
    throw new VoiceLeadValidationError("VOICE_LEAD_INVALID_DETAILS", parsed.error.issues
      .map((issue) => issue.path[0] as VoiceLeadField));
  }
  const identity = parsed.data;
  const phone = normalizeVoiceIdentityPhone(params.contactPhone);
  if (!phone) {
    throw new VoiceLeadValidationError("VOICE_LEAD_CALLER_PHONE_UNAVAILABLE");
  }
  if (identity.phone !== undefined && normalizeVoiceIdentityPhone(identity.phone) !== phone) {
    throw new VoiceLeadValidationError("VOICE_LEAD_PHONE_MISMATCH", ["phone"]);
  }
  if (identity.callback_phone !== undefined) {
    const callbackPhone = normalizeVoiceIdentityPhone(identity.callback_phone);
    if (!callbackPhone) throw new VoiceLeadValidationError("VOICE_LEAD_INVALID_DETAILS", ["callback_phone"]);
    identity.callback_phone = callbackPhone;
  }

  const existing = await findExistingLead(params.siteId, phone, identity.email);
  if (existing) return completeProvisionalLead(existing, identity);

  const db = tenantDatabase();
  const { data: site, error: siteError } = await db.from("sites")
    .select("id, user_id")
    .eq("id", params.siteId)
    .maybeSingle();
  if (
    siteError || site?.id !== params.siteId
    || !z.string().uuid().safeParse(site?.user_id).success
  ) {
    throw new Error("Unable to resolve the Voice lead site owner");
  }

  // PK uniqueness makes duplicate/reordered/reformatted webhook retries and
  // concurrent native calls for this tenant/caller converge without an upsert
  // that would overwrite the winning profile. Do not depend on raw JSON, model
  // details, messageId/sessionId or timestamps, which can change on a retry.
  const leadId = uuidv5(`zavu-voice-lead:${params.siteId}:${phone}`, uuidv5.URL);
  const { error: insertError } = await db.from("leads").insert({
    id: leadId,
    site_id: params.siteId,
    user_id: site.user_id,
    name: identity.name,
    email: identity.email,
    phone,
    ...(identity.company ? { company: { name: identity.company } } : {}),
    status: "contacted",
    origin: "voice",
    metadata: {
      voice_identification: identificationMetadata(identity.callback_phone),
    },
  });
  if (insertError) {
    if (insertError.code === "23505") {
      const winner = await findExistingLead(params.siteId, phone, identity.email);
      if (winner) return completeProvisionalLead(winner, identity);
    }
    // Do not surface database errors (which may include PII/other tenant data).
    throw new Error("Unable to create Voice lead");
  }
  return { success: true, lead_id: leadId, is_new_lead: true, contact_details_saved: true };
}