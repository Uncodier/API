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
  channels?: { channel: string; identifier: string }[];
  availableChannels?: string[];
  metadata?: Record<string, string>;
}

const CONTACT_LOOKUP_TIMEOUT_MS = 8_000;

function unwrapContact(payload: unknown): ZavuContact {
  const envelope = payload && typeof payload === "object"
    ? payload as { contact?: unknown }
    : undefined;
  const contact = envelope?.contact ?? payload;
  if (
    !contact || typeof contact !== "object" || !("id" in contact)
    || typeof contact.id !== "string" || !contact.id.trim()
  ) {
    throw new Error("Zavu contact response is missing contact data");
  }
  return contact as ZavuContact;
}

async function getContactByPhone(
  phone: string,
  signal: AbortSignal
): Promise<ZavuContact | null> {
  try {
    return unwrapContact(
      await zavuFetch(
        `/contacts/phone/${encodeURIComponent(phone)}`,
        { signal },
        { silentStatuses: [404] }
      )
    );
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function hasVoicePhone(contact: ZavuContact, phone: string): boolean {
  return Array.isArray(contact.channels) && contact.channels.some((channel) =>
    channel?.channel === "voice" && channel.identifier === phone
  );
}

function requireContactMetadata(contact: ZavuContact): void {
  if (
    !contact.metadata || typeof contact.metadata !== "object"
    || Array.isArray(contact.metadata)
    || Object.values(contact.metadata).some((value) => typeof value !== "string")
  ) {
    // Never replace metadata using a partial provider response.
    throw new Error("Zavu contact response is missing complete metadata");
  }
}

async function getVoiceContacts(phone: string): Promise<ZavuContact[]> {
  // One deadline covers the entire lookup, not a fresh timeout for each page.
  const signal = AbortSignal.timeout(CONTACT_LOOKUP_TIMEOUT_MS);
  const contacts = new Map<string, ZavuContact>();
  const legacyContact = await getContactByPhone(phone, signal);
  if (legacyContact) {
    // Preserve existing SMS/WhatsApp contact reuse from the exact phone API.
    requireContactMetadata(legacyContact);
    contacts.set(legacyContact.id, legacyContact);
  }

  // Voice-only contacts can lack primaryPhone and are invisible to both the
  // legacy lookup and search. Scan unfiltered pages even after a legacy hit:
  // older lifecycle events may have created additional Voice-only duplicates.
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const search = new URLSearchParams({ limit: "100" });
    if (cursor) search.set("cursor", cursor);
    const page = await zavuFetch<{
      items?: unknown[];
      nextCursor?: string | null;
    }>(`/contacts?${search}`, { signal });
    if (
      !page || !Array.isArray(page.items)
      || (page.nextCursor != null
        && (typeof page.nextCursor !== "string" || !page.nextCursor))
    ) {
      throw new Error("Zavu contact list response is incomplete");
    }
    for (const item of page.items) {
      const contact = unwrapContact(item);
      if (!Array.isArray(contact.channels)) {
        if (
          !Array.isArray(contact.availableChannels)
          || contact.availableChannels.some((channel) => typeof channel !== "string")
          || contact.availableChannels.includes("voice")
        ) {
          throw new Error("Zavu contact list response is missing channel data");
        }
        continue;
      }
      if (contact.channels.some((channel) =>
        !channel || typeof channel.channel !== "string"
        || typeof channel.identifier !== "string"
      )) {
        throw new Error("Zavu contact list response contains invalid channel data");
      }
      // Deliberately avoid suffix matching, phone heuristics and non-Voice
      // identifiers: this metadata can contain private call guidance.
      if (hasVoicePhone(contact, phone) || contact.id === legacyContact?.id) {
        requireContactMetadata(contact);
        contacts.set(contact.id, contact);
      }
    }
    // The documented list schema requires items, but makes nextCursor optional.
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (cursors.has(cursor)) {
        throw new Error("Zavu contact pagination repeated a cursor");
      }
      cursors.add(cursor);
    }
  } while (cursor);
  signal.throwIfAborted();
  return Array.from(contacts.values());
}

function selectVoiceContact(
  contacts: ZavuContact[],
  phone: string,
  deliveryId: string
): ZavuContact | undefined {
  return contacts.sort((a, b) => {
    const owned = (contact: ZavuContact) => Number(
      contact.metadata?.[VOICE_CONTEXT_METADATA_KEYS.deliveryId] === deliveryId
    );
    return owned(b) - owned(a)
      || Number(hasVoicePhone(b, phone)) - Number(hasVoicePhone(a, phone))
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  })[0];
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
  let contact = selectVoiceContact(
    await getVoiceContacts(params.phone), params.phone, params.deliveryId
  );
  if (!contact) {
    try {
      await createVoiceContact(params.phone, guidance);
      return;
    } catch (error: any) {
      if (error?.status !== 400) throw error;
      contact = selectVoiceContact(
        await getVoiceContacts(params.phone), params.phone, params.deliveryId
      );
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
  const contacts = await getVoiceContacts(params.phone);
  for (const contact of contacts) {
    // Do not clear an observed newer owner. Zavu's metadata PATCH has no
    // documented compare-and-set, so concurrent external writes are not atomic.
    if (contact.metadata?.[VOICE_CONTEXT_METADATA_KEYS.deliveryId] !== params.deliveryId) {
      continue;
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
}
