import { z } from "zod";
import { zavuFetch } from "./client";

export const zavuSenderIdSchema = z.string().min(1).max(128)
  .refine((id) => /^[A-Za-z0-9]/.test(id) && !/[^A-Za-z0-9_-]/.test(id));

export interface WhatsAppSenderDisplay {
  id: string;
  whatsapp: { displayPhoneNumber: string | null };
}

const senderSchema = z.object({
  id: zavuSenderIdSchema,
  whatsapp: z.object({
    displayPhoneNumber: z.string().trim().max(64).nullish(),
  }).nullish(),
});

// The shared client otherwise logs untrusted provider error bodies.
const silentStatuses = Array.from({ length: 300 }, (_, index) => index + 300);

/** Call only after verifying site access and the persisted WhatsApp connection. */
export async function getWhatsAppSenderDisplay(senderId: string): Promise<WhatsAppSenderDisplay> {
  try {
    zavuSenderIdSchema.parse(senderId);
    const payload = await zavuFetch<unknown>(
      `/senders/${encodeURIComponent(senderId)}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(8_000),
        redirect: "error",
        cache: "no-store",
      },
      { silentStatuses }
    );
    // GET /v1/senders/{senderId} returns a raw Sender, not an invitation.
    // https://docs.zavu.dev/api-reference/get-sender.md
    const sender = senderSchema.parse(payload);
    if (sender.id !== senderId) throw new Error("Sender ID mismatch");

    return {
      id: senderId,
      whatsapp: {
        // phoneNumber is not necessarily a WhatsApp number. Never fall back to it.
        displayPhoneNumber: sender.whatsapp?.displayPhoneNumber || null,
      },
    };
  } catch {
    throw new Error("Failed to retrieve WhatsApp sender");
  }
}