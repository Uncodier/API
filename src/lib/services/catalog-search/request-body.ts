import { readBoundedText } from '@/lib/security/request-body';

export { BodyTooLargeError as CatalogBodyTooLargeError } from '@/lib/security/request-body';

export async function readCatalogJson(request: Request, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readBoundedText(request, maxBytes));
}