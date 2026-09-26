import type { DocumentKind, DocumentReadOptions, DocumentReadResult, LoadedDocument } from './types';
import { readCsv, readPdf, readPresentation, readSpreadsheet, readText, readWordDocument } from './readers';
import { loadOfficeZip, type SafeOfficeZip } from './officeZip';

const MIME_BY_KIND: Record<DocumentKind, string> = {
  pdf: 'application/pdf', presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', csv: 'text/csv', text: 'text/plain',
};
const PARSE_DEADLINE_MS = 15_000;

// Bounds how long the caller waits across detection and extraction. Parsers that
// execute synchronous CPU work require Worker isolation for hard cancellation.
async function withParseDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Document parsing exceeded the 15 second limit.')), PARSE_DEADLINE_MS);
    timer.unref?.();
  });
  try { return await Promise.race([operation, deadline]); }
  finally { if (timer) clearTimeout(timer); }
}

async function detect(file: LoadedDocument): Promise<{ type: DocumentKind; officeZip?: SafeOfficeZip }> {
  const extension = file.filename.toLowerCase().split('.').pop();
  if (file.buffer.subarray(0, 5).toString() === '%PDF-' || file.mimeType === 'application/pdf' || extension === 'pdf') return { type: 'pdf' };
  if (file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const officeZip = await loadOfficeZip(file.buffer);
    if (officeZip.zip.file('word/document.xml')) return { type: 'document', officeZip };
    if (officeZip.zip.file('xl/workbook.xml')) return { type: 'spreadsheet', officeZip };
    if (officeZip.zip.file('ppt/presentation.xml')) return { type: 'presentation', officeZip };
    throw new Error('ZIP document is not a supported OOXML package.');
  }
  const hintedOfficeType: DocumentKind | undefined = file.mimeType.includes('presentation') || extension === 'pptx' ? 'presentation'
    : file.mimeType.includes('spreadsheet') || extension === 'xlsx' ? 'spreadsheet'
      : file.mimeType.includes('wordprocessing') || extension === 'docx' ? 'document' : undefined;
  if (hintedOfficeType) return { type: hintedOfficeType, officeZip: await loadOfficeZip(file.buffer) };
  if (file.mimeType === 'text/csv' || extension === 'csv') return { type: 'csv' };
  if (file.mimeType.startsWith('text/') || ['txt', 'md', 'json', 'xml'].includes(extension || '')) return { type: 'text' };
  throw new Error('Unsupported document type. Supported formats: PDF, PPTX, XLSX, DOCX, CSV, TXT, MD, JSON and XML. Legacy PPT, XLS and DOC files must first be converted to their modern format or PDF.');
}

export async function detectDocumentKind(file: LoadedDocument): Promise<DocumentKind> {
  return (await detect(file)).type;
}

type MutableLocation = { value: string; set: (value: string) => void };

function collectMutableStrings(value: unknown, locations: MutableLocation[]): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && !['type', 'mime_type'].includes(key)) {
      locations.push({ value: child, set: replacement => { (value as Record<string, unknown>)[key] = replacement; } });
    } else collectMutableStrings(child, locations);
  }
}

function fitSerializedResult(result: DocumentReadResult, maxChars: number): DocumentReadResult {
  const length = () => JSON.stringify(result).length;
  while (length() > maxChars) {
    const strings: MutableLocation[] = [];
    collectMutableStrings(result, strings);
    const longest = strings.sort((a, b) => b.value.length - a.value.length)[0];
    if (longest?.value.length) {
      const excess = length() - maxChars;
      longest.set(longest.value.slice(0, Math.max(0, longest.value.length - excess)));
      result.truncated = true;
      continue;
    }
    const table = [...result.sections].reverse().flatMap(section => section.tables ?? []).find(candidate => candidate.rows.length > 0);
    if (table) { table.rows.pop(); result.truncated = true; continue; }
    const metadataSection = result.sections.find(section => section.metadata && Object.keys(section.metadata).length);
    if (metadataSection?.metadata) { delete metadataSection.metadata[Object.keys(metadataSection.metadata)[0]!]; result.truncated = true; continue; }
    if (result.warnings.length) { result.warnings.pop(); result.truncated = true; continue; }
    if (result.sections.length > 1) { result.sections.pop(); result.truncated = true; continue; }
    const metadataKey = Object.keys(result.metadata)[0];
    if (metadataKey) { delete result.metadata[metadataKey]; result.truncated = true; continue; }
    throw new Error('maxChars is too small for the document result envelope.');
  }
  return result;
}

function boundResult(result: DocumentReadResult, options: DocumentReadOptions): DocumentReadResult {
  const maxSections = options.maxSections ?? 50;
  const maxChars = options.maxChars ?? 60_000;
  let remaining = maxChars;
  let truncated = result.sections.length > maxSections;
  const sections = result.sections.slice(0, maxSections).map(section => {
    const text = section.text || '';
    const bounded = text.slice(0, Math.max(remaining, 0));
    remaining -= bounded.length;
    if (bounded.length < text.length) truncated = true;
    const tables = section.tables?.map(table => ({
      rows: table.rows.flatMap(row => {
        if (remaining <= 0) {
          truncated = true;
          return [];
        }
        const boundedRow = row.map(cell => {
          const serialized = typeof cell === 'string' ? cell : (JSON.stringify(cell) ?? String(cell));
          const value = serialized.slice(0, remaining);
          remaining -= value.length;
          if (value.length < serialized.length) truncated = true;
          return typeof cell === 'string' ? value : value === serialized ? cell : value;
        });
        return [boundedRow];
      }),
    }));
    return { ...section, ...(section.text !== undefined ? { text: bounded } : {}), ...(tables ? { tables } : {}) };
  });
  return fitSerializedResult({ ...result, sections, truncated }, maxChars);
}

async function readDocumentBufferInternal(file: LoadedDocument, options: DocumentReadOptions): Promise<DocumentReadResult> {
  const { type, officeZip } = await detect(file);
  const parsed = type === 'pdf' ? await readPdf(file.buffer, options)
    : type === 'presentation' ? await readPresentation(file.buffer, options, officeZip)
      : type === 'spreadsheet' ? await readSpreadsheet(file.buffer, options, officeZip)
        : type === 'document' ? await readWordDocument(file.buffer, officeZip)
          : type === 'csv' ? readCsv(file.buffer) : readText(file.buffer);
  return boundResult({ success: true, type, filename: file.filename, mime_type: file.mimeType || MIME_BY_KIND[type], metadata: { byte_size: file.buffer.length, ...parsed.metadata }, sections: parsed.sections, truncated: false, warnings: parsed.warnings }, options);
}

export async function readDocumentBuffer(file: LoadedDocument, options: DocumentReadOptions = {}): Promise<DocumentReadResult> {
  if (options.maxSections !== undefined && (!Number.isInteger(options.maxSections) || options.maxSections < 1 || options.maxSections > 100)) throw new Error('maxSections must be an integer between 1 and 100.');
  if (options.maxChars !== undefined && (!Number.isInteger(options.maxChars) || options.maxChars < 1_000 || options.maxChars > 120_000)) throw new Error('maxChars must be an integer between 1000 and 120000.');
  return withParseDeadline(readDocumentBufferInternal(file, options));
}