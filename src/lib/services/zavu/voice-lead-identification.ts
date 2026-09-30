import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/database/supabase-server";

const identitySchema = z.object({
  name: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
  email: z.string().trim().max(254).email().transform((email) => email.toLowerCase()),
  phone: z.string().trim().min(1).max(80).optional(),
  company: z.string().trim().max(200).optional(),
});

type LeadIdentity = { id: string; site_id: string; email: string | null; phone: string | null };

export type VoiceLeadIdentificationResult = {
  success: true;
  lead_id: string;
  is_new_lead: boolean;
};

function tenantDatabase() {
  return supabaseAdmin.schema(
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
    || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA
    || "public"
  );
}

/** Do not guess a country or remove digits from a caller identity. */
export function normalizeVoiceIdentityPhone(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80) return undefined;
  let phone = value.trim().replace(/[\s().-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : undefined;
}

function conflict(): never {
  // Deliberately do not reveal which other profile/contact detail matched.
  throw new Error("Voice lead identity conflicts with existing records; request human assistance");
}

async function findExistingLead(
  siteId: string,
  phone: string,
  email: string
): Promise<string | undefined> {
  const db = tenantDatabase();
  // Separate filters avoid an email OR phone / limit(1) arbitrary identity merge.
  // Escape LIKE metacharacters: a literal '_' or '%' in an email is not a wildcard.
  const emailPattern = email.replace(/[\\%_]/g, "\\$&");
  const [phoneResult, emailResult] = await Promise.all([
    db.from("leads")
      .select("id, site_id, email, phone")
      .eq("site_id", siteId)
      .eq("phone", phone)
      .limit(2),
    db.from("leads")
      .select("id, site_id, email, phone")
      .eq("site_id", siteId)
      .ilike("email", emailPattern)
      .limit(2),
  ]);
  if (phoneResult.error || emailResult.error) {
    throw new Error("Unable to check existing Voice lead identity");
  }
  const phoneMatches = (phoneResult.data || []) as LeadIdentity[];
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
    || phoneLead.phone !== phone
    || !z.string().uuid().safeParse(phoneLead.id).success
    || (phoneLead.email?.trim() && phoneLead.email.trim().toLowerCase() !== email)
  ) conflict();
  // Existing names/company, blank contact fields, status and opt-outs are not
  // overwritten based on unverified caller-supplied attributes.
  return phoneLead.id;
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
    throw new Error("Explicit caller consent is required to identify a Voice lead");
  }
  if (!z.string().uuid().safeParse(params.siteId).success) {
    throw new Error("A valid authoritative site is required for Voice lead identification");
  }
  // Zod strips unknown fields: never forward site/user/lead/visitor IDs, metadata,
  // conversation, command_id, or any other model-controlled persistence fields.
  const parsed = identitySchema.safeParse(params.arguments);
  if (!parsed.success) {
    throw new Error("Voice lead identification requires a nonblank name and valid email and contact details");
  }
  const identity = parsed.data;
  const phone = normalizeVoiceIdentityPhone(params.contactPhone);
  if (!phone) {
    throw new Error("A trusted caller phone in international format is required for Voice lead identification");
  }
  if (identity.phone !== undefined && normalizeVoiceIdentityPhone(identity.phone) !== phone) {
    throw new Error("Confirmed phone must match the trusted Voice caller phone");
  }

  const existingId = await findExistingLead(params.siteId, phone, identity.email);
  if (existingId) return { success: true, lead_id: existingId, is_new_lead: false };

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
      voice_identification: {
        consent: true,
        consent_scope: "store_contact_details_and_be_contacted",
        consent_recorded_at: new Date().toISOString(),
      },
    },
  });
  if (insertError) {
    if (insertError.code === "23505") {
      const winnerId = await findExistingLead(params.siteId, phone, identity.email);
      if (winnerId) return { success: true, lead_id: winnerId, is_new_lead: false };
    }
    // Do not surface database errors (which may include PII/other tenant data).
    throw new Error("Unable to create Voice lead");
  }
  return { success: true, lead_id: leadId, is_new_lead: true };
}