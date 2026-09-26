import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { extractText } from 'unpdf';
import { posix } from 'node:path';
import type { DocumentReadOptions, DocumentSection } from './types';
import { loadOfficeZip, type SafeOfficeZip } from './officeZip';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: false, maxNestedTags: 100 });
const orderedXml = new XMLParser({ preserveOrder: true, ignoreAttributes: true, processEntities: false, maxNestedTags: 100, trimValues: false });
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_PRESENTATION_SLIDES = 1_000;
const SLIDE_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/slide',
]);
const NOTES_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide',
]);
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const selected = (number: number, requested?: number[]) => !requested?.length || requested.includes(number);

async function readZipXml(packageFile: SafeOfficeZip, path: string, label: string): Promise<string> {
  const file = packageFile.zip.file(path);
  if (!file) throw new Error(`${label} is missing.`);
  const declaredSize = packageFile.expandedSizes.get(path);
  if (declaredSize === undefined) throw new Error(`${label} has no validated ZIP metadata.`);
  if (declaredSize > MAX_XML_BYTES) throw new Error(`${label} exceeds the 8 MB expanded XML limit.`);
  const bytes = await file.async('uint8array');
  if (bytes.byteLength > MAX_XML_BYTES) throw new Error(`${label} exceeds the 8 MB expanded XML limit.`);
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE/i.test(value)) throw new Error(`${label} contains a forbidden DOCTYPE declaration.`);
  return value;
}

type OrderedNode = Record<string, unknown>;
const orderedChildren = (node: unknown, tag: string): OrderedNode[] => {
  if (Array.isArray(node)) return node.flatMap(item => item && typeof item === 'object' && Array.isArray((item as OrderedNode)[tag]) ? [(item as OrderedNode)] : orderedChildren(item, tag));
  if (node && typeof node === 'object') return Object.values(node).flatMap(value => orderedChildren(value, tag));
  return [];
};
const semanticText = (node: unknown, textTag: 'w:t' | 'a:t'): string => {
  if (!Array.isArray(node)) return '';
  let output = '';
  for (const item of node) {
    if (!item || typeof item !== 'object') continue;
    for (const [tag, children] of Object.entries(item as OrderedNode)) {
      if (tag === textTag && Array.isArray(children)) {
        output += children.map(child => child && typeof child === 'object' ? String((child as OrderedNode)['#text'] ?? '') : '').join('');
      } else if (textTag === 'w:t' && tag === 'w:tab') output += '\t';
      else if (textTag === 'w:t' && (tag === 'w:br' || tag === 'w:cr')) output += '\n';
      else if (tag !== ':@' && tag !== '#text' && tag !== 'w:del') output += semanticText(children, textTag);
    }
  }
  return output;
};
const cleanText = (value: string) => value.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();

function relationshipMap(document: unknown): Map<string, { target: string; type: string; external: boolean }> {
  const relationships = list((document as Record<string, any>)?.Relationships?.Relationship);
  const result = new Map<string, { target: string; type: string; external: boolean }>();
  for (const relationship of relationships as Array<Record<string, unknown>>) {
    const id = String(relationship?.['@_Id'] ?? '');
    const target = String(relationship?.['@_Target'] ?? '');
    if (!id || !target) continue;
    if (result.has(id)) throw new Error(`Duplicate OOXML relationship ID ${id}.`);
    result.set(id, { target, type: String(relationship?.['@_Type'] ?? ''), external: relationship?.['@_TargetMode'] === 'External' });
  }
  return result;
}

function resolvePackageTarget(sourcePath: string, target: string): string {
  if (target.startsWith('/') || target.includes('\\')) throw new Error('OOXML relationship contains an unsafe target.');
  const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), target));
  if (resolved === '..' || resolved.startsWith('../')) throw new Error('OOXML relationship escapes the package root.');
  return resolved;
}

export async function readPdf(buffer: Buffer, options: DocumentReadOptions): Promise<{ sections: DocumentSection[]; metadata: Record<string, unknown>; warnings: string[] }> {
  const extracted = await extractText(new Uint8Array(buffer), { mergePages: false });
  const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
  return {
    sections: pages.flatMap((text, index) => selected(index + 1, options.pages) ? [{ id: `page-${index + 1}`, title: `Page ${index + 1}`, text }] : []),
    metadata: { page_count: extracted.totalPages },
    warnings: pages.every(page => !page.trim()) ? ['No embedded text was found. This PDF may require OCR.'] : [],
  };
}

export async function readSpreadsheet(buffer: Buffer, options: DocumentReadOptions, loaded?: SafeOfficeZip) {
  if (!loaded) await loadOfficeZip(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sections: DocumentSection[] = [];
  workbook.eachSheet(sheet => {
    if (options.sheets?.length && !options.sheets.includes(sheet.name)) return;
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: false }, row => {
      if (rows.length >= 500) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map(value => {
        if (value && typeof value === 'object' && 'formula' in value) {
          const formula = value as { formula: string; result?: unknown };
          return { formula: formula.formula, result: formula.result ?? null };
        }
        if (value && typeof value === 'object' && 'text' in value) return (value as { text: string }).text;
        return value instanceof Date ? value.toISOString() : value ?? null;
      }));
    });
    sections.push({ id: `sheet-${sheet.id}`, title: sheet.name, tables: [{ rows }], metadata: { row_count: sheet.rowCount, column_count: sheet.columnCount, rows_truncated: sheet.rowCount > 500 } });
  });
  return { sections, metadata: { sheet_count: workbook.worksheets.length, sheet_names: workbook.worksheets.map(sheet => sheet.name) }, warnings: [] as string[] };
}

export async function readPresentation(buffer: Buffer, options: DocumentReadOptions, loaded?: SafeOfficeZip) {
  const packageFile = loaded ?? await loadOfficeZip(buffer);
  const presentationPath = 'ppt/presentation.xml';
  const presentationRelsPath = 'ppt/_rels/presentation.xml.rels';
  const presentation = xml.parse(await readZipXml(packageFile, presentationPath, 'PPTX presentation'));
  const relationships = relationshipMap(xml.parse(await readZipXml(packageFile, presentationRelsPath, 'PPTX presentation relationships')));
  const ids = list((presentation as Record<string, any>)?.['p:presentation']?.['p:sldIdLst']?.['p:sldId']).map((item: Record<string, unknown>) => String(item?.['@_r:id'] ?? '')).filter(Boolean);
  if (ids.length > MAX_PRESENTATION_SLIDES) throw new Error(`PPTX exceeds the ${MAX_PRESENTATION_SLIDES} slide limit.`);
  const slideFiles = ids.map(id => {
    const relationship = relationships.get(id);
    if (!relationship || relationship.external || !SLIDE_RELATIONSHIP_TYPES.has(relationship.type)) throw new Error(`Invalid or external slide relationship ${id}.`);
    const target = resolvePackageTarget(presentationPath, relationship.target);
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(target)) throw new Error(`Slide relationship ${id} targets an invalid package part.`);
    return target;
  });
  if (new Set(ids).size !== ids.length || new Set(slideFiles).size !== slideFiles.length) throw new Error('PPTX contains duplicate slide relationships.');
  const sections: DocumentSection[] = [];
  for (let index = 0; index < slideFiles.length; index += 1) {
    const number = index + 1;
    if (!selected(number, options.slides)) continue;
    const slidePath = slideFiles[index]!;
    const slide = orderedXml.parse(await readZipXml(packageFile, slidePath, `Slide ${number}`));
    const relsPath = posix.join(posix.dirname(slidePath), '_rels', `${posix.basename(slidePath)}.rels`);
    let notes = '';
    if (packageFile.zip.file(relsPath)) {
      const relationships = relationshipMap(xml.parse(await readZipXml(packageFile, relsPath, `Slide ${number} relationships`)));
      const notesRelationship = Array.from(relationships.values()).find(relationship => !relationship.external && NOTES_RELATIONSHIP_TYPES.has(relationship.type));
      if (notesRelationship) {
        const notesPath = resolvePackageTarget(slidePath, notesRelationship.target);
        if (!/^ppt\/notesSlides\/[^/]+\.xml$/.test(notesPath)) throw new Error(`Slide ${number} notes target an invalid package part.`);
        const notesDocument = orderedXml.parse(await readZipXml(packageFile, notesPath, `Slide ${number} notes`));
        notes = cleanText(semanticText(notesDocument, 'a:t'));
      }
    }
    const text = cleanText(semanticText(slide, 'a:t'));
    sections.push({ id: `slide-${number}`, title: `Slide ${number}`, text, metadata: notes ? { notes } : undefined });
  }
  return { sections, metadata: { slide_count: slideFiles.length }, warnings: [] as string[] };
}

export async function readWordDocument(buffer: Buffer, loaded?: SafeOfficeZip) {
  const packageFile = loaded ?? await loadOfficeZip(buffer);
  const document = orderedXml.parse(await readZipXml(packageFile, 'word/document.xml', 'DOCX document XML'));
  const bodyNode = orderedChildren(document, 'w:body')[0];
  const body = bodyNode?.['w:body'];
  if (!Array.isArray(body)) throw new Error('Invalid DOCX: document body is missing.');
  const paragraphs: string[] = [];
  const tables: Array<{ rows: unknown[][] }> = [];
  const orderedBlocks: string[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray((item as OrderedNode)['w:p'])) {
      const paragraph = cleanText(semanticText((item as OrderedNode)['w:p'], 'w:t'));
      if (paragraph) { paragraphs.push(paragraph); orderedBlocks.push(paragraph); }
    } else if (Array.isArray((item as OrderedNode)['w:tbl'])) {
      const rows = orderedChildren((item as OrderedNode)['w:tbl'], 'w:tr').map(row =>
        orderedChildren(row['w:tr'], 'w:tc').map(cell => cleanText(semanticText(cell['w:tc'], 'w:t'))));
      tables.push({ rows });
      orderedBlocks.push(rows.map(row => row.join('\t')).join('\n'));
    }
  }
  return {
    sections: [{ id: 'document', title: paragraphs[0] || undefined, text: orderedBlocks.filter(Boolean).join('\n'), ...(tables.length ? { tables } : {}) }],
    metadata: { paragraph_count: paragraphs.length, table_count: tables.length },
    warnings: [] as string[],
  };
}

export function readCsv(buffer: Buffer) {
  const rows = parseCsv(buffer, { bom: true, relax_column_count: true, skip_empty_lines: true, to: 501 }) as unknown[][];
  return { sections: [{ id: 'table-1', title: 'CSV data', tables: [{ rows: rows.slice(0, 500) }], metadata: { rows_truncated: rows.length > 500 } }], metadata: { rows_returned: Math.min(rows.length, 500) }, warnings: [] as string[] };
}

export function readText(buffer: Buffer) {
  return { sections: [{ id: 'text', text: buffer.toString('utf8') }], metadata: {}, warnings: [] as string[] };
}