import { zavuFetch } from "./client";

export const VOICE_CONTEXT_METADATA_KEYS = {
  deliveryId: "makinari_voice_delivery_id",
  siteId: "makinari_voice_site_id",
  objective: "makinari_voice_call_objective",
  additionalContext: "makinari_voice_call_additional_context",
  followUpContext: "makinari_voice_follow_up_context",
} as const;

interface ZavuContact {
  id: string;
  metadata?: Record<string, string>;
}

function unwrapContact(payload: unknown): ZavuContact {
  const envelope = payload && typeof payload === "object"
    ? payload as { contact?: unknown }
    : undefined;
  const contact = envelope?.contact ?? payload;
  if (!contact || typeof contact !== "object" || !("id" in contact)) {
    throw new Error("Zavu contact response is missing contact data");
  }
  return contact as ZavuContact;
}

async function getContactByPhone(phone: string): Promise<ZavuContact | null> {
  try {
    return unwrapContact(
      await zavuFetch(`/contacts/phone/${encodeURIComponent(phone)}`)
    );
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function createVoiceContact(
  phone: string,
  metadata: Record<string, string>
): Promise<ZavuContact> {
  return unwrapContact(
    await zavuFetch("/contacts", {
      method: "POST",
      body: JSON.stringify({
        channels: [{
          channel: "voice",
          identifier: phone,
          isPrimary: true,
        }],
        metadata,
      }),
    })
  );
}

async function updateContactMetadata(
  contactId: string,
  metadata: Record<string, string>
): Promise<ZavuContact> {
  return unwrapContact(
    await zavuFetch(`/contacts/${encodeURIComponent(contactId)}`, {
      method: "PATCH",
      body: JSON.stringify({ metadata }),
    })
  );
}

function callMetadata(params: {
  deliveryId: string;
  siteId: string;
  objective?: string;
  additionalContext?: string;
  followUpContext?: string;
}): Record<string, string> {
  return {
    [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: params.deliveryId,
    [VOICE_CONTEXT_METADATA_KEYS.siteId]: params.siteId,
    [VOICE_CONTEXT_METADATA_KEYS.objective]: params.objective || "",
    [VOICE_CONTEXT_METADATA_KEYS.additionalContext]:
      params.additionalContext || "",
    [VOICE_CONTEXT_METADATA_KEYS.followUpContext]:
      params.followUpContext || "",
  };
}

function withoutVoiceContext(
  metadata: Record<string, string> | undefined
): Record<string, string> {
  const next = { ...(metadata || {}) };
  for (const key of Object.values(VOICE_CONTEXT_METADATA_KEYS)) {
    delete next[key];
  }
  return next;
}

export async function setVoiceCallContactContext(params: {
  phone: string;
  deliveryId: string;
  siteId: string;
  objective?: string;
  additionalContext?: string;
  followUpContext?: string;
}): Promise<void> {
  const guidance = callMetadata(params);
  let contact = await getContactByPhone(params.phone);
  if (!contact) {
    try {
      await createVoiceContact(params.phone, guidance);
      return;
    } catch (error: any) {
      if (error?.status !== 400) throw error;
      contact = await getContactByPhone(params.phone);
      if (!contact) throw error;
    }
  }
  await updateContactMetadata(contact.id, {
    ...withoutVoiceContext(contact.metadata),
    ...guidance,
  });
}

export async function clearVoiceCallContactContext(params: {
  phone: string;
  deliveryId: string;
}): Promise<void> {
  const contact = await getContactByPhone(params.phone);
  if (
    !contact
    || contact.metadata?.[VOICE_CONTEXT_METADATA_KEYS.deliveryId]
      !== params.deliveryId
  ) {
    return;
  }
  await updateContactMetadata(
    contact.id,
    {
      ...withoutVoiceContext(contact.metadata),
      [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "",
      [VOICE_CONTEXT_METADATA_KEYS.siteId]: "",
      [VOICE_CONTEXT_METADATA_KEYS.objective]: "",
      [VOICE_CONTEXT_METADATA_KEYS.additionalContext]: "",
      [VOICE_CONTEXT_METADATA_KEYS.followUpContext]: "",
    }
  );
}
