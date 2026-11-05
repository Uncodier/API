import { zavuFetch } from "./client";

export interface ZavuEmailAttachment {
  filename: string;
  content: string;
  content_type?: string;
  content_id?: string;
}

// MESSAGING
export async function sendChannelMessage(params: {
  to: string;
  text?: string;
  channel?: string;
  senderId?: string;
  subject?: string;
  htmlBody?: string;
  replyTo?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  attachments?: ZavuEmailAttachment[];
  signal?: AbortSignal;
  messageType?: "text" | "image" | "video" | "audio" | "document";
  content?: { mediaUrl: string; mimeType?: string };
}): Promise<any> {
  const { senderId, to, text, channel, subject, htmlBody, messageType, content,
    replyTo, metadata, idempotencyKey, attachments, signal } = params;

  return zavuFetch("/messages", {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: {
      ...(senderId ? { "Zavu-Sender": senderId } : {}),
    },
    body: JSON.stringify({
      to,
      ...(text !== undefined ? { text } : {}),
      ...(channel ? { channel } : {}),
      ...(subject ? { subject } : {}),
      ...(htmlBody ? { htmlBody } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(metadata ? { metadata } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(attachments ? { attachments } : {}),
      ...(messageType ? { messageType } : {}),
      ...(content ? { content } : {}),
    }),
  }, { acceptMessageReplay: Boolean(idempotencyKey) });
}
