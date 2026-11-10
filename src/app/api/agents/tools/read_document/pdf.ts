import { getDocumentProxy } from 'unpdf';
import type { DocumentReadOptions, DocumentSection } from './types';
import { isolatedPdfImages } from './pdf-isolation';

export const MAX_PDF_IMAGES = 5;
export const MAX_PDF_IMAGE_BYTES = 8 * 1024 * 1024;

export async function readPdf(buffer: Buffer, options: DocumentReadOptions) {
  // Text extraction never requests an operator list/image decode in this process.
  const pdf = await getDocumentProxy(new Uint8Array(buffer), {
    maxImageSize: 0, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    useWasm: false,
  });
  const sections: DocumentSection[] = [];
  const warnings: string[] = [];
  const textless: number[] = [];
  let truncated = false;
  const pageCount = pdf.numPages;
  try {
    const requested = options.pages?.length ? new Set(options.pages) : undefined;
    for (let number = 1; number <= pageCount; number++) {
      if (requested && !requested.has(number)) continue;
      if (sections.length >= (options.maxSections ?? 50)) { truncated = true; break; }
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
        sections.push({ id: `page-${number}`, title: `Page ${number}`, text });
        if (!text) textless.push(number);
      } finally { page.cleanup(); }
    }
  } finally { await pdf.loadingTask.destroy(); }
  if (truncated) warnings.push('PDF pages were omitted by maxSections.');
  if (!textless.length) return { sections, metadata: { page_count: pageCount }, warnings, truncated };
  warnings.push('Selected PDF pages had no embedded text. Embedded-image fallback is not OCR or a full-page render; layout may be unavailable.');
  try {
    const decoded = await isolatedPdfImages(buffer, textless);
    return { sections, metadata: { page_count: pageCount }, warnings: [...warnings, ...decoded.warnings],
      truncated: truncated || decoded.truncated, ...(decoded.images.length ? { images: decoded.images } : {}) };
  } catch {
    warnings.push('PDF images could not be decoded safely: isolation unavailable, busy, or a resource limit was reached. Retry or provide page images/OCR.');
    return { sections, metadata: { page_count: pageCount }, warnings, truncated: true };
  }
}