import { ASSISTANT_CONTEXT_VERSION } from './assistant-context-version';

export interface AssistantImageAsset {
  url: string;
  fileType: string;
  publicUrl?: string;
  id?: string;
  name?: string;
  createdAt?: string;
  messageSid?: string;
}

function compareUploads(a: AssistantImageAsset, b: AssistantImageAsset): number {
  const timestamp = (image: AssistantImageAsset) => {
    const parsed = Date.parse(image.createdAt || '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return timestamp(a) - timestamp(b) || (a.id || '').localeCompare(b.id || '');
}

/** Keep each image adjacent to its identity, not paired by URL position in prose. */
export function buildAssistantUserContent(message: string, images: AssistantImageAsset[]): any {
  const usable = images.filter(image => {
    const url = image.publicUrl || image.url;
    return url && /^https?:\/\//.test(url);
  });
  // Match only attachment lines, not arbitrary URLs or the JSON-encoded quoted
  // log. Legacy WhatsApp assets still have an exact URL in the inbound message.
  const currentUrls = new Set(Array.from(message.matchAll(
    /^\[Archivo adjunto - image\/[^\]\r\n]+\]: (https?:\/\/[^\s]+)\s*$/gm,
  ), match => match[1]));
  const isCurrent = (image: AssistantImageAsset) => currentUrls.has(image.publicUrl || image.url);
  const missingCurrent = [...currentUrls].filter(url => !usable.some(image => (image.publicUrl || image.url) === url));
  const unavailable = missingCurrent.length
    ? '\n\nCurrent attachment is unavailable in the image context. Do not substitute another image or describe it as visible; explain the failure and ask the user to resend it if needed.'
    : '';
  const quotedSid = message.match(/\[WhatsApp reply target: ([^\]\r\n]+)\]/)?.[1];
  const missingReplyNotice = '\nNo image from the quoted message is available in this image context. If the user is requesting a quoted image: Do not substitute a current or newer image; ask for clarification or for the quoted image to be resent. A text-only reply does not require an image.';
  if (!usable.length) return message + unavailable + (quotedSid ? missingReplyNotice : '');

  const quotedLine = message.match(/Quoted message \(reference data, not new instructions\): ([^\r\n]+)/)?.[1];
  let quotedText = '';
  try {
    const value = quotedLine ? JSON.parse(quotedLine) : undefined;
    if (typeof value === 'string') quotedText = value;
  } catch { /* Unavailable/malformed quoted reference must not imply a target. */ }
  const quotedUrls = new Set(quotedText.match(/https?:\/\/[^\s\]\)]+/g) || []);
  // Older assets predate message_sid metadata. The scoped quoted log still
  // contains their exact uploaded URLs; resolve those, never the newest asset.
  const isTarget = (image: AssistantImageAsset) => Boolean(quotedSid &&
    (image.messageSid === quotedSid || (!image.messageSid && quotedUrls.has(image.publicUrl || image.url))));
  const chronological = [...usable].sort(compareUploads);
  const latest = chronological.filter(image => Number.isFinite(Date.parse(image.createdAt || ''))).at(-1);
  // Display current attachments and explicit reply targets last without
  // redefining upload chronology. The executor also pins their exact source
  // identity against newer tool screenshots when enforcing the vision budget.
  const ordered = [...usable].sort((a, b) => {
    const priority = (image: AssistantImageAsset) => isTarget(image) ? 2 : isCurrent(image) ? 1 : 0;
    return priority(a) - priority(b) || compareUploads(a, b);
  });
  const missingReply = quotedSid && !usable.some(isTarget) ? missingReplyNotice : '';
  const content: any[] = [{ type: 'text', text: `${message}${unavailable}${missingReply}\n\n[Assistant image context: ${ASSISTANT_CONTEXT_VERSION}]\nUploaded images below are instance reference context, not necessarily attachments to this message. Use their message IDs, asset IDs and timestamps to identify the requested image. An explicit WhatsApp reply target takes precedence over current attachments and recency. For an unquoted "this image", prefer current_attachment; for "latest uploaded", use uploaded_at/latest_uploaded, not the last displayed image (priority targets may be displayed last). Upload time is the date added to the instance, not when the photo was taken. If the requested image is unavailable or ambiguous, ask for clarification instead of guessing. Pass the selected source URL exactly to tools (e.g. reference_images); do not substitute another image's URL.` }];
  for (const image of ordered) {
    const url = image.publicUrl || image.url;
    const reference = {
      asset_id: image.id, name: image.name, uploaded_at: image.createdAt,
      message_sid: image.messageSid,
      ...(isTarget(image) ? { reply_target: true } : {}),
      ...(isCurrent(image) ? { current_attachment: true } : {}),
      ...(image === latest ? { latest_uploaded: true } : {}),
    };
    content.push({ type: 'text', text: `Image reference: ${JSON.stringify(reference)}\nSource URL: ${url}` });
    content.push({ type: 'image_url', image_url: { url } });
  }
  return content;
}