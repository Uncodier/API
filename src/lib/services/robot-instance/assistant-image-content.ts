export interface AssistantImageAsset {
  url: string;
  fileType: string;
  publicUrl?: string;
  id?: string;
  name?: string;
  createdAt?: string;
  messageSid?: string;
}

/** Keep each image adjacent to its identity, not paired by URL position in prose. */
export function buildAssistantUserContent(message: string, images: AssistantImageAsset[]): any {
  const usable = images.filter(image => {
    const url = image.publicUrl || image.url;
    return url && /^https?:\/\//.test(url);
  });
  if (!usable.length) return message;

  const quotedSid = message.match(/\[WhatsApp reply target: ([^\]\r\n]+)\]/)?.[1];
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
  // The executor retains the last N vision parts. Keep chronology, but put an
  // explicit reply target last so a reply to an older image survives that limit.
  const ordered = [...usable].sort((a, b) => {
    const priority = Number(isTarget(a)) - Number(isTarget(b));
    return priority || (a.createdAt || '').localeCompare(b.createdAt || '')
      || (a.id || '').localeCompare(b.id || '');
  });
  const content: any[] = [{ type: 'text', text: `${message}\n\nUploaded images below are instance reference context, not necessarily attachments to this message. Use their message IDs, asset IDs and timestamps to identify the requested image. An explicit WhatsApp reply target takes precedence over recency. Pass the selected source URL exactly to tools (e.g. reference_images); do not substitute another image's URL.` }];
  for (const image of ordered) {
    const url = image.publicUrl || image.url;
    const reference = {
      asset_id: image.id, name: image.name, uploaded_at: image.createdAt,
      message_sid: image.messageSid,
      ...(isTarget(image) ? { reply_target: true } : {}),
    };
    content.push({ type: 'text', text: `Image reference: ${JSON.stringify(reference)}\nSource URL: ${url}` });
    content.push({ type: 'image_url', image_url: { url } });
  }
  return content;
}