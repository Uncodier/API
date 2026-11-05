import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assertPhoneResourcesAvailable,
  assignNumberToSender,
  attachSenderToAgent,
  createSender,
  ensureProjectWebhook,
  ensureSenderWebhook,
  getChannelConnection,
  getOwnedNumbers,
  isChannelActivationBlocked,
  purchaseNumber,
  requireZavuSiteManager,
  upsertChannelConnection,
  updateSender,
  zavuFetch,
} from "@/lib/services/zavu";
import { patchActivationConnection, requireActivationLicense } from "@/lib/services/zavu/activation-persistence";

import { prepareActivationWebhookSecret } from "@/lib/services/zavu/activation-webhook-secret";
import { encryptToken } from "@/lib/utils/token-encryption";

export async function POST(request: NextRequest) {
  let persistedChannelId: string | undefined;
  let senderId: string | undefined;
  let authorized = false;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid SMS configuration" }, { status: 400 });
    }
    const parsed = z.object({
      siteId: z.string().uuid(),
      channelId: z.string().uuid().optional(),
      name: z.string().trim().max(100).optional(),
      phoneNumber: z.string().trim().min(5).max(30).optional(),
      active: z.boolean().optional(),
    }).strict().safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid SMS configuration" }, { status: 400 });
    }
    const { siteId, channelId, name } = parsed.data;
    await requireZavuSiteManager(request, siteId);
    authorized = true;
    const existing = await getChannelConnection(siteId, channelId);
    if (existing && existing.type !== "sms") {
      return NextResponse.json({ error: "Channel connection is not an SMS channel" }, { status: 409 });
    }
    if (isChannelActivationBlocked(existing)) {
      return NextResponse.json({ error: "Channel connection is disabled or license-suspended" }, { status: 409 });
    }
    if (existing) {
      await requireActivationLicense(siteId, channelId!, { type: "sms", senderId: existing.zavu_sender_id || null });
    }
    const phoneNumber = parsed.data.phoneNumber || existing?.metadata?.phone_number;
    if (phoneNumber) {
      await assertPhoneResourcesAvailable(siteId, { phoneNumber });
    }

    // The provider returns its one-time secret before configuring the webhook.
    // Save that identity in the creation callback so webhook failure is retryable.
    const persistPending = async (created: Awaited<ReturnType<typeof createSender>>) => {
      if (typeof created?.id !== "string" || !created.id) throw new Error("Invalid sender");
      senderId = created.id;
      const pending = {
        type: "sms",
        name: name || existing?.name || "SMS Channel",
        // Verification retries must not release an established licensed slot.
        status: existing?.status === "connected" ? "connected" : "in_progress",
        zavu_sender_id: senderId,
        metadata: {
          phone_number: phoneNumber, activation_pending: true, activation_error: null, provider_channel_active: false,
          ...(created.webhook?.secret ? { zavu_webhook_secret: encryptToken(created.webhook.secret) } : {}),
        },
      };
      if (existing) {
        await patchActivationConnection(siteId, channelId!, pending, { type: "sms", senderId: existing.zavu_sender_id || null });
        persistedChannelId = channelId;
      } else {
        ({ channelId: persistedChannelId } = await upsertChannelConnection(siteId, channelId, pending));
      }
    };
    let sender: Awaited<ReturnType<typeof createSender>>;
    if (existing?.zavu_sender_id) {
      sender = { id: existing.zavu_sender_id } as typeof sender;
      await persistPending(sender);
    } else {
      sender = await createSender({
        name: name || `SMS Agent for Site ${siteId}`,
        enableSmsOneway: true,
      }, { onCreated: persistPending });
    }
    if (!persistedChannelId || sender?.id !== senderId) throw new Error("Invalid persisted sender");
    const expected = { type: "sms", senderId: senderId! };
    await requireActivationLicense(siteId, persistedChannelId!, expected);

    await ensureProjectWebhook();
    if (existing?.zavu_sender_id) {
      sender = await ensureSenderWebhook(senderId!);
      if (sender?.id !== senderId) throw new Error("Invalid webhook sender");
    }
    await prepareActivationWebhookSecret(siteId, persistedChannelId!, expected, sender.webhook?.secret);
    await patchActivationConnection(siteId, persistedChannelId!, {
      metadata: {
        webhook_events: sender.webhook?.events || [],
      },
    }, expected);
    await requireActivationLicense(siteId, persistedChannelId!, expected);
    if (existing?.zavu_sender_id) {
      // SMS uses sender configuration, not the five-channel activation endpoint.
      await updateSender(senderId!, { enableSmsOneway: true });
    }
    if (phoneNumber) {
      const owned = await getOwnedNumbers();
      const numbers = owned?.items || owned?.results || (Array.isArray(owned) ? owned : null);
      if (!Array.isArray(numbers)) throw new Error("Invalid phone-number response");
      if (!numbers.some((number: any) => number.phoneNumber === phoneNumber)) {
        await purchaseNumber(phoneNumber);
      }
      const assignment = await assignNumberToSender(senderId!, phoneNumber);
      const phone = typeof assignment?.phoneNumber === "object" ? assignment.phoneNumber : assignment;
      const regulatoryStatus = phone?.regulatoryStatus || phone?.regulatory_status || phone?.regulatory?.status;
      await patchActivationConnection(siteId, persistedChannelId!, {
        metadata: { regulatory_status: regulatoryStatus || null },
      }, expected);
      // Assignment can succeed while review is pending; one-way capability is not
      // proof that this requested number is ready for two-way SMS.
      // https://docs.zavu.dev/api-reference/update-phone-number
      if (phone?.phoneNumber !== phoneNumber || phone?.senderId !== senderId || regulatoryStatus !== "approved") {
        throw new Error("SMS phone-number readiness could not be confirmed");
      }
    }
    await attachSenderToAgent(senderId!);

    // GET sender documents channels as actual capability, not inferred configuration.
    // https://docs.zavu.dev/api-reference/get-sender
    const payload = await zavuFetch<any>(`/senders/${encodeURIComponent(senderId!)}`);
    const confirmed = payload?.sender || payload;
    if (confirmed?.id !== senderId || !Array.isArray(confirmed.channels)
      || !confirmed.channels.some((channel: unknown) => channel === "sms" || channel === "sms_oneway")) {
      throw new Error("Zavu did not confirm SMS readiness");
    }
    await requireActivationLicense(siteId, persistedChannelId!, expected);
    const connection = await patchActivationConnection(siteId, persistedChannelId!, {
      status: "connected",
      metadata: { activation_pending: false, activation_error: null, provider_channel_active: true },
    }, expected);

    return NextResponse.json({
      success: true,
      channelId: persistedChannelId,
      senderId,
      status: connection.status,
      activationPending: connection.metadata.activation_pending,
      providerChannelActive: connection.metadata.provider_channel_active,
    });
  } catch (error: any) {
    const status = !authorized && [401, 403].includes(error?.status) ? error.status : 502;
    return NextResponse.json(
      {
        error: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Zavu could not complete SMS setup",
        ...(persistedChannelId ? { channelId: persistedChannelId, senderId } : {}),
      },
      { status }
    );
  }
}
