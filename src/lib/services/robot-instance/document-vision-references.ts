import { createHash } from 'node:crypto';
import { documentImageContent } from '@/lib/agentbase/services/command/document-image-content';
import type { ReadDocumentToolParams } from '@/app/api/agents/tools/read_document/assistantProtocol';
import type { DocumentReadResult } from '@/app/api/agents/tools/read_document/types';

const REFERENCE = Symbol('documentVisionReference');
const PREFIX = '[PDF image reference]: ';
const MAX_IMAGES = 5;
const MAX_CHARS = 8 * 1024 * 1024;
type Reference = { version: 1; args: ReadDocumentToolParams; page: number; index: number; sha256: string };
type DocumentFunction = { id: string; name: string; status: string; args: ReadDocumentToolParams; result: unknown };
const digest = (url: string) => createHash('sha256').update(url).digest('hex');

/** Symbol metadata is in-process only; the provider receives standard vision parts. */
export function isDocumentVisionImage(part: any): boolean {
  return part?.type === 'image_url' && Boolean(part[REFERENCE]);
}

export function documentVisionContent(functions: DocumentFunction[]): any[] | undefined {
  const content = documentImageContent('', functions);
  if (!Array.isArray(content)) return undefined;
  return content.map(part => {
    if (part.type !== 'image_url') return part;
    // Match the same most-recent source ordering used by documentImageContent.
    const current = [...functions].reverse().find(fn =>
      (fn.result as DocumentReadResult)?.images?.some(image => image.data_url === part.image_url.url));
    if (!current) return part;
    const result = current.result as DocumentReadResult;
    const index = result.images?.findIndex(image => image.data_url === part.image_url.url) ?? -1;
    if (index < 0) return part;
    const reference: Reference = { version: 1, args: { ...current.args }, page: result.images![index].page,
      index, sha256: digest(part.image_url.url) };
    return { ...part, [REFERENCE]: reference };
  });
}

/** Checkpoints store the original read arguments and image identity, never bytes. */
export function dehydrateDocumentImage(part: any): any | undefined {
  if (!isDocumentVisionImage(part)) return undefined;
  return { type: 'text', text: PREFIX + JSON.stringify(part[REFERENCE]) };
}

export async function hydrateDocumentImages(messages: any[]): Promise<void> {
  const cache = new Map<string, Promise<DocumentReadResult>>();
  let count = 0;
  let chars = 0;
  for (const message of messages) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    for (let index = 0; index < message.content.length; index++) {
      const part = message.content[index];
      if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.startsWith(PREFIX)) continue;
      // Failure remains explicit and carries no arbitrary downloader/decoder error.
      message.content[index] = { type: 'text', text: 'PDF image unavailable: the saved image could not be restored or exceeded the vision budget. It is NOT visible. Do not infer its contents; use read_document again or ask the user to resend the PDF.' };
      try {
        const ref = JSON.parse(part.text.slice(PREFIX.length)) as Reference;
        if (ref.version !== 1 || !Number.isInteger(ref.page) || ref.page < 1 || !Number.isInteger(ref.index)
          || ref.index < 0 || ref.index >= MAX_IMAGES || !/^[a-f0-9]{64}$/.test(ref.sha256)
          || !ref.args || typeof ref.args.url !== 'string' || count >= MAX_IMAGES) continue;
        const key = JSON.stringify(ref.args);
        if (!cache.has(key)) {
          if (cache.size >= MAX_IMAGES) continue;
          const { readDocumentTool } = await import('@/app/api/agents/tools/read_document/assistantProtocol');
          cache.set(key, readDocumentTool().execute(ref.args));
        }
        const result = await cache.get(key)!;
        const image = result.images?.[ref.index];
        if (!result.success || image?.page !== ref.page || image.mime_type !== 'image/png'
          || typeof image.data_url !== 'string' || image.data_url.length + chars > MAX_CHARS
          || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.data_url)
          || digest(image.data_url) !== ref.sha256) continue;
        count++;
        chars += image.data_url.length;
        message.content[index] = { type: 'image_url', image_url: { url: image.data_url }, [REFERENCE]: ref };
      } catch { /* Changed/expired sources and decoder limits fail closed. */ }
    }
  }
}