import { getVisionImageSourceUrl } from '@/lib/services/robot-instance/vision-message-images';
import { isDocumentVisionImage } from '@/lib/services/robot-instance/document-vision-references';

export const MAX_SCREENSHOT_HISTORY = 5;
export type ScreenshotState = { lastHash: string | null; identicalCount: number; history: string[] };

/**
 * Detects whether a string looks like a raw base64 encoded raster image (PNG, JPEG, GIF, WEBP)
 * by checking the leading magic bytes in base64 form. Purely length-based heuristics cause
 * large file contents from tools like `sandbox_read_file` to be misclassified as screenshots,
 * corrupting the conversation (`[Image captured...]` placeholder) and producing Azure vision
 * errors (`invalid_image_format` / `dropped from history`).
 */
function isLikelyBase64ImagePayload(value: string): boolean {
  if (!value || value.length < 64) return false;
  const head = value.slice(0, 24);
  if (!/^[A-Za-z0-9+/=_-]+$/.test(head)) return false;
  return (
    head.startsWith('/9j/') ||        // JPEG (FFD8FF)
    head.startsWith('iVBORw0KGgo') || // PNG  (89 50 4E 47 0D 0A 1A 0A)
    head.startsWith('R0lGOD') ||      // GIF87a / GIF89a
    head.startsWith('UklGR')          // RIFF / WEBP
  );
}

/** Only the generated linked-reference envelope, never arbitrary URL mentions. */
function linkedImageSources(content: any[]): Set<string> {
  const text = content[0]?.type === 'text' ? content[0].text : undefined;
  if (typeof text !== 'string') return new Set();
  const match = text.match(/^\[Reference Context from linked node ([^\]\r\n]+)\]:\nNode reference: (\{[^\r\n]*\})\n/);
  if (!match) return new Set();
  try {
    const reference = JSON.parse(match[2]);
    if (typeof reference.node_id !== 'string' || !reference.node_id || reference.reference_type !== match[1]) return new Set();
    // The generated URL list is appended after untrusted linked-node prose.
    const listStart = text.lastIndexOf('\n\nCRITICAL - Image URLs for reference (');
    const list = listStart >= 0
      ? text.slice(listStart).match(/^\n\nCRITICAL - Image URLs for reference \([^\r\n]*\):\n([\s\S]*)$/)?.[1] : undefined;
    return new Set(list?.split('\n') || []);
  } catch {
    return new Set();
  }
}

function imageReferencePriority(content: any[], index: number, source: string, linked: Set<string>): number {
  // Node execution must use linked assets, not unrelated conversation history.
  if (linked.has(source)) return 3;
  const label = content[index - 1];
  const match = label?.type === 'text' && typeof label.text === 'string'
    ? label.text.match(/^Image reference: (\{[^\r\n]*\})\nSource URL: ([^\r\n]+)$/) : undefined;
  // Document context outranks screenshots, but never explicit user/node targets.
  if (!match || match[2] !== source) return isDocumentVisionImage(content[index]) ? 0.5 : 0;
  try {
    const reference = JSON.parse(match[1]);
    return reference.reply_target === true ? 2 : reference.current_attachment === true ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * Bound vision parts without letting new tool screenshots evict explicit targets.
 * Rank linked-node, reply, then current references before other images; break ties
 * by latest occurrence. Select exact sources once, but never reorder identity or
 * chronology text. All selection state is local, with no extra provider fields.
 */
export function filterImages(messages: any[], imagesToKeep: number): void {
  type Candidate = { messageIndex: number; partIndex: number; source: string; priority: number };
  const candidates: Candidate[] = [];
  const invalid = new Map<any, string>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    const linked = linkedImageSources(msg.content);
    for (let partIndex = 0; partIndex < msg.content.length; partIndex++) {
      const part = msg.content[partIndex];
      if (part?.type !== 'image_url') continue;
      const raw = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const source = getVisionImageSourceUrl(part);
      if (typeof raw !== 'string' || !/^(data:image\/|https?:\/\/)/.test(raw) || !source) {
        invalid.set(part, 'Image unavailable: invalid image source. This image is NOT visible. Do not substitute another image or infer its contents.');
        continue;
      }
      candidates.push({ messageIndex, partIndex, source,
        priority: imageReferencePriority(msg.content, partIndex, source, linked) });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority || b.messageIndex - a.messageIndex || b.partIndex - a.partIndex);
  const selected = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (selected.size >= imagesToKeep) break;
    if (!selected.has(candidate.source)) selected.set(candidate.source, candidate);
  }
  for (const candidate of candidates) {
    if (selected.get(candidate.source) === candidate) continue;
    const { messageIndex, partIndex, source } = candidate;
    // Never turn large inline bytes into text or a provider-specific metadata field.
    const identity = /^https?:\/\//.test(source) ? JSON.stringify(source)
      : `inline image at message ${messageIndex + 1}, part ${partIndex + 1}`;
    const reason = selected.has(source)
      ? 'Duplicate image occurrence omitted; exact-source duplicates share one vision slot'
      : `Image omitted from vision due to the ${imagesToKeep}-image limit`;
    messages[messageIndex].content[partIndex] = { type: 'text', text: `${reason}: ${identity}. This occurrence is NOT visible; identity text alone is not image access. Do not describe or infer its contents unless this exact source is attached elsewhere in this request. If a requested image is not attached, explain the limit and ask for fewer images; do not substitute another image.` };
  }

  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      msg.content = msg.content.map((part: any) => invalid.has(part) ? { type: 'text', text: invalid.get(part) } : part);
    }

    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.content.includes('base64') || msg.content.length > 50000) {
        console.log(`🧹 [IMAGE_FILTER] Cleaning base64 data from tool message`);
        msg.content = msg.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
      }

      if (msg.content.includes('generateImage') || msg.content.includes('image_urls') || msg.content.includes('provider')) {
        console.log(`🧹 [IMAGE_FILTER] Cleaning generateImage tool message content`);
        msg.content = msg.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
      }
    }
  }
}

/**
 * Extract and strip base64 images from tool results
 * Images will be sent separately as user messages (OpenAI requirement)
 */
export function extractBase64Image(result: any): { cleanedResult: any; base64Image: string | null } {
  let base64Image: string | null = null;

  if (typeof result === 'object' && result !== null && result.provider && result.image_urls) {
    console.log(`🧹 [IMAGE_FILTER] Processing generateImage tool result`);
    return {
      cleanedResult: result,
      base64Image: null
    };
  }

  if (typeof result === 'string') {
    if (result.startsWith('data:image') || isLikelyBase64ImagePayload(result)) {
      const imageData = result.startsWith('data:image') ? result : `data:image/png;base64,${result}`;
      return {
        cleanedResult: 'Screenshot captured successfully.',
        base64Image: imageData
      };
    }
    return { cleanedResult: result, base64Image: null };
  }

  if (typeof result === 'object' && result !== null) {
    const cleaned: any = Array.isArray(result) ? [] : {};

    for (const [key, value] of Object.entries(result)) {
      if (key === 'base64_image' || key === 'base64Image' || key === 'screenshot' || key === 'image') {
        if (
          typeof value === 'string' &&
          (value.startsWith('data:image') || isLikelyBase64ImagePayload(value))
        ) {
          base64Image = value.startsWith('data:image') ? value : `data:image/png;base64,${value}`;
          cleaned[key] = '[Image captured - will be shown separately]';
        } else {
          cleaned[key] = value;
        }
      } else if (
        typeof value === 'string' &&
        (value.startsWith('data:image') || isLikelyBase64ImagePayload(value))
      ) {
        base64Image = value.startsWith('data:image') ? value : `data:image/png;base64,${value}`;
        cleaned[key] = '[Image captured - will be shown separately]';
      } else if (typeof value === 'object' && value !== null) {
        const nested = extractBase64Image(value);
        cleaned[key] = nested.cleanedResult;
        if (nested.base64Image && !base64Image) {
          base64Image = nested.base64Image;
        }
      } else {
        cleaned[key] = value;
      }
    }

    return { cleanedResult: cleaned, base64Image };
  }

  return { cleanedResult: result, base64Image: null };
}
