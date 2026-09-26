import { readDocumentBuffer } from './core';
import { downloadDocument } from './source';
import type { DocumentReadOptions } from './types';

export type ReadDocumentToolParams = DocumentReadOptions & { url: string };

function positiveIntegers(value: unknown, name: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => !Number.isInteger(item) || item < 1)) throw new Error(`${name} must be an array of positive integers.`);
  return value as number[];
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  return value as number;
}

function validateArgs(value: unknown): ReadDocumentToolParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('read_document arguments must be an object.');
  const args = value as Record<string, unknown>;
  const allowed = new Set(['url', 'pages', 'slides', 'sheets', 'maxSections', 'maxChars']);
  if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('read_document received an unknown argument.');
  if (typeof args.url !== 'string' || !args.url.trim()) throw new Error('url is required and must be a non-empty string.');
  if (args.sheets !== undefined && (!Array.isArray(args.sheets) || args.sheets.some(sheet => typeof sheet !== 'string' || !sheet))) throw new Error('sheets must be an array of non-empty strings.');
  return {
    url: args.url,
    pages: positiveIntegers(args.pages, 'pages'),
    slides: positiveIntegers(args.slides, 'slides'),
    sheets: args.sheets as string[] | undefined,
    maxSections: boundedInteger(args.maxSections, 'maxSections', 1, 100),
    maxChars: boundedInteger(args.maxChars, 'maxChars', 1_000, 120_000),
  };
}

export function readDocumentTool() {
  return {
    name: 'read_document',
    description: 'Read a document from a public or signed HTTP(S) URL. Automatically detects PDF, PPTX presentations, XLSX spreadsheets, DOCX documents, CSV and text files. Returns normalized sections and preserves spreadsheet formulas, tables, slide notes and page/slide/sheet boundaries where available. Scanned PDFs need OCR and legacy PPT/XLS/DOC files must be converted first.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public or signed HTTP(S) URL of the document.' },
        pages: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Optional 1-based PDF pages to return.' },
        slides: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Optional 1-based presentation slides to return.' },
        sheets: { type: 'array', items: { type: 'string' }, description: 'Optional exact spreadsheet sheet names to return.' },
        maxSections: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum sections returned. Default 50.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Maximum serialized JSON characters returned, including text, tables and metadata. Default 60000.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execute: async (rawArgs: ReadDocumentToolParams) => {
      const args = validateArgs(rawArgs);
      return readDocumentBuffer(await downloadDocument(args.url), args);
    },
  };
}