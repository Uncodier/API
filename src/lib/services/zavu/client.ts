const ZAVU_API_BASE = "https://api.zavu.dev/v1";

export type ConnectionType = "whatsapp_waba" | "messenger";

export interface ZavuInvitation {
  id: string;
  url: string;
  token: string;
  status?: string;
  senderId?: string | null;
  connectedAccount?: unknown;
}

function getApiKey(): string {
  const apiKey = process.env.ZAVUDEV_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ZAVUDEV_API_KEY in environment variables");
  }
  return apiKey;
}

async function zavuFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ZAVU_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }

  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Zavu API ${response.status}`);
    (error as any).status = response.status;
    throw error;
  }

  return payload as T;
}

function unwrapInvitation(payload: any): ZavuInvitation {
  const invitation = payload?.invitation || payload;
  if (!invitation?.id || !invitation?.url) {
    throw new Error("Zavu invitation response is missing id or url");
  }
  return invitation;
}

function unwrapSender(payload: any) {
  const sender = payload?.sender || payload;
  if (!sender?.id) {
    throw new Error("Zavu sender response is missing id");
  }
  return sender;
}

function unwrapEmailDomain(payload: any) {
  const domain = payload?.domain || payload;
  if (!domain?.id) {
    throw new Error("Zavu email domain response is missing id");
  }
  return domain;
}

export async function createPartnerInvitation(params: {
  clientName: string;
  clientEmail?: string;
  connectionType: ConnectionType;
  expiresInDays?: number;
}): Promise<ZavuInvitation> {
  const payload = await zavuFetch("/invitations", {
    method: "POST",
    body: JSON.stringify({
      clientName: params.clientName,
      clientEmail: params.clientEmail,
      connectionType: params.connectionType,
      expiresInDays: params.expiresInDays || 14,
    }),
  });
  return unwrapInvitation(payload);
}

export async function getInvitation(id: string): Promise<ZavuInvitation> {
  return unwrapInvitation(await zavuFetch(`/invitations/${id}`));
}

export async function cancelInvitation(id: string): Promise<void> {
  await zavuFetch(`/invitations/${id}/cancel`, { method: "POST" });
}

export async function updateSenderWebhook(senderId: string, webhookUrl: string) {
  return zavuFetch(`/senders/${senderId}`, {
    method: "PATCH",
    body: JSON.stringify({
      webhookUrl,
      webhookEvents: ["message.inbound", "invitation.status_changed"],
      webhookActive: true,
      webhookSignatureVersion: "v1+v2",
    }),
  });
}

export async function attachSenderToAgent(senderId: string) {
  const agentId = process.env.ZAVUDEV_AGENT_ID;
  if (!agentId) {
    console.warn("[Zavu] ZAVUDEV_AGENT_ID is not set; sender will not be attached to an agent");
    return null;
  }

  return zavuFetch(`/agents/${agentId}/senders`, {
    method: "POST",
    body: JSON.stringify({ senderId }),
  });
}

// SENDER & CHANNELS
export async function createSender(params: {
  name: string;
  enableSmsOneway?: boolean;
  emailAddress?: string;
  emailFromName?: string;
  emailDomainId?: string;
  emailReceivingEnabled?: boolean;
  webhookUrl?: string;
  webhookEvents?: string[];
  setAsDefault?: boolean;
}): Promise<any> {
  return unwrapSender(
    await zavuFetch("/senders", {
      method: "POST",
      body: JSON.stringify({
        ...params,
        ...(params.webhookUrl ? { webhookSignatureVersion: "v1+v2" } : {}),
      }),
    })
  );
}

export async function updateSender(senderId: string, params: {
  emailAddress?: string;
  emailFromName?: string;
  emailReceivingEnabled?: boolean;
  webhookUrl?: string;
  webhookEvents?: string[];
  webhookActive?: boolean;
}): Promise<any> {
  return zavuFetch(`/senders/${senderId}`, {
    method: "PATCH",
    body: JSON.stringify(params),
  });
}

export async function connectTelegram(senderId: string, botToken: string): Promise<any> {
  return zavuFetch(`/senders/${senderId}/telegram`, {
    method: "POST",
    body: JSON.stringify({ botToken }),
  });
}

// EMAIL DOMAINS
export async function addEmailDomain(domain: string): Promise<any> {
  return unwrapEmailDomain(
    await zavuFetch("/email-domains", {
      method: "POST",
      body: JSON.stringify({ domain }),
    })
  );
}

export async function getEmailDomain(domainId: string): Promise<any> {
  return unwrapEmailDomain(
    await zavuFetch(`/email-domains/${domainId}`, {
      method: "GET",
    })
  );
}

export async function verifyEmailDomain(domainId: string): Promise<any> {
  const payload = await zavuFetch(`/email-domains/${domainId}/verify`, {
    method: "POST",
  });
  try {
    return unwrapEmailDomain(payload);
  } catch {
    return getEmailDomain(domainId);
  }
}

// MESSAGING
export async function sendChannelMessage(params: {
  to: string;
  text: string;
  channel?: string;
  senderId?: string;
  subject?: string;
  htmlBody?: string;
}): Promise<any> {
  const { senderId, to, text, channel, subject, htmlBody } = params;

  return zavuFetch("/messages", {
    method: "POST",
    headers: {
      ...(senderId ? { "Zavu-Sender": senderId } : {}),
    },
    body: JSON.stringify({
      to,
      text,
      ...(channel ? { channel } : {}),
      ...(subject ? { subject } : {}),
      ...(htmlBody ? { htmlBody } : {}),
    }),
  });
}
