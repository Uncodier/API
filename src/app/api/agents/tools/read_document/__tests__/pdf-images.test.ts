import { deflateSync, inflateSync } from 'node:zlib';
import { readDocumentBuffer } from '../core';
import { encodePng, MAX_IMAGE_PIXELS } from '../png';
import { prepareMessagesForTarget } from '@/lib/agentbase/agents/targetEvaluator/formatters/target-message-formatter';
import { prepareMessagesFromCommand } from '@/lib/agentbase/agents/toolEvaluator/messageFormatter';
import type { DbCommand } from '@/lib/agentbase/models/types';

// Only these generated fixtures use the decoder in-process. Production always
// requires the OS-limited child; macOS cannot enforce Linux RLIMIT_DATA.
jest.mock('../pdf-isolation', () => ({
  isolatedPdfImages: (buffer: Buffer, pages: number[]) => require('../pdf-decoder.cjs').decodePdfImages(buffer, pages),
}));

// Real PDF image XObjects; binary stream lengths and xref offsets are exact.
function imagePdf(kinds: Array<'text' | 'image' | 'blank'>): Buffer {
  const objects: Buffer[] = [];
  const add = (value: string | Buffer) => { objects.push(Buffer.from(value)); return objects.length; };
  const stream = (dictionary: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const image = add(stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode', deflateSync(pixels)));
  const pages = kinds.map(kind => {
    const content = add(stream('', Buffer.from(kind === 'blank' ? '' : kind === 'text' ? 'BT /F1 12 Tf 10 50 Td (Readable page) Tj ET' : 'q 100 0 0 100 0 0 cm /Im1 Do Q')));
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pages.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(parts.reduce((size, part) => size + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n'));
  }
  const xref = parts.reduce((size, part) => size + part.length, 0);
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function decodePng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const idat: Buffer[] = [];
  let ended = false;
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const name = png.toString('ascii', offset + 4, offset + 8);
    if (name === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + size));
    if (name === 'IEND') ended = true;
    offset += size + 12;
  }
  expect(ended).toBe(true);
  return inflateSync(Buffer.concat(idat));
}

const file = (kinds: Array<'text' | 'image' | 'blank'>) => ({ buffer: imagePdf(kinds), filename: 'synthetic.pdf', mimeType: 'application/pdf' });

describe('real PDF embedded-image fallback', () => {
  it('passes a real extracted PNG through both model message boundaries', async () => {
    const result = await readDocumentBuffer(file(['image']));
    const command = {
      id: 'synthetic', agent_background: 'Read the attached document.', context: 'Current message: [document]',
      functions: [{ name: 'read_document', status: 'completed', result }], tools: [],
    } as unknown as DbCommand;
    for (const messages of [prepareMessagesForTarget(command, 'Test'), prepareMessagesFromCommand(command, 'Test')]) {
      const parts = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
      expect(parts).toContainEqual(expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: result.images![0]!.data_url }) }));
      const text = messages.map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n');
      expect(text).not.toContain(result.images![0]!.data_url);
    }
  });
  it('encodes actual pixels as a complete PNG outside the text budget', async () => {
    const result = await readDocumentBuffer(file(['image']), { maxChars: 1000 });
    const { images, ...text } = result;
    expect(JSON.stringify(text).length).toBeLessThanOrEqual(1000);
    expect(images).toHaveLength(1);
    expect(images![0]).toMatchObject({ page: 1, mime_type: 'image/png' });
    const png = Buffer.from(images![0]!.data_url.split(',')[1]!, 'base64');
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(2);
    expect(decodePng(png)).toEqual(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]));
    expect(result.warnings.join(' ')).toMatch(/not OCR/);
  });

  it('handles mixed PDFs and respects pages and maxSections', async () => {
    const source = file(['text', 'image', 'image']);
    const mixed = await readDocumentBuffer(source);
    expect(mixed.sections[0]!.text).toContain('Readable page');
    expect(mixed.images!.map(image => image.page)).toEqual([2, 3]);
    const limited = await readDocumentBuffer(source, { pages: [2, 3], maxSections: 1 });
    expect(limited.sections.map(section => section.id)).toEqual(['page-2']);
    expect(limited.images!.map(image => image.page)).toEqual([2]);
    expect(limited.truncated).toBe(true);
    const textOnly = await readDocumentBuffer(source, { pages: [1] });
    expect(textOnly.images).toBeUndefined();
    expect(textOnly.warnings).toEqual([]);
  });

  it('truthfully reports blank pages without claiming OCR or images', async () => {
    const result = await readDocumentBuffer(file(['blank']));
    expect(result.images).toBeUndefined();
    expect(result.warnings.join(' ')).toMatch(/no extractable embedded images/);
  });

  it('caps output at five complete images and preserves the truncation signal', async () => {
    const result = await readDocumentBuffer(file(Array(7).fill('image')), { maxChars: 1000 });
    expect(result.images).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.images!.reduce((bytes, image) => bytes + image.data_url.length, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    for (const image of result.images!) decodePng(Buffer.from(image.data_url.split(',')[1]!, 'base64'));
  });
});

describe('bounded PNG encoder', () => {
  it.each([1, 3, 4])('supports %i-channel pixels', channels => {
    const data = new Uint8Array(channels).fill(128);
    const png = encodePng({ width: 1, height: 1, channels, data });
    expect(decodePng(png)).toEqual(Buffer.from([0, ...data]));
    expect(png[25]).toBe(channels === 1 ? 0 : channels === 3 ? 2 : 6);
  });
  it('rejects pixel bombs and invalid layouts before allocating scanlines', () => {
    expect(() => encodePng({ width: MAX_IMAGE_PIXELS, height: 2, channels: 4, data: new Uint8Array() })).toThrow(/pixel/);
    expect(() => encodePng({ width: 1, height: 1, channels: 3, data: new Uint8Array(2) })).toThrow(/layout/);
  });
});