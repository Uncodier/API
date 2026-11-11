export interface EmailAttachment {
  filename: string;
  content: string;
  content_type?: string;
}

/** Base64 only: never accept local paths, arbitrary headers or remote URLs here. */
export function validateEmailAttachments(input: unknown): EmailAttachment[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 10) throw new Error('At most 10 email attachments are supported');
  let bytes = 0;
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['filename', 'content', 'content_type'].includes(key))
      || typeof item.filename !== 'string' || !item.filename.trim() || item.filename.length > 255
      || /[\x00-\x1f/\\]/.test(item.filename)
      || typeof item.content !== 'string' || !item.content || item.content.length > 28_000_000
      || item.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.content)
      || (item.content_type !== undefined && (typeof item.content_type !== 'string'
        || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.content_type)))) {
      throw new Error('Invalid base64 email attachment');
    }
    const decoded = Buffer.from(item.content, 'base64');
    bytes += decoded.length;
    if (decoded.toString('base64') !== item.content || bytes > 20 * 1024 * 1024) throw new Error('Email attachments exceed 20 MB or contain invalid base64');
    return { filename: item.filename, content: item.content,
      ...(item.content_type !== undefined ? { content_type: item.content_type } : {}) };
  });
}