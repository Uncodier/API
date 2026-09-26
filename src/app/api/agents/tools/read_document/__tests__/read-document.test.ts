import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { detectDocumentKind, readDocumentBuffer } from '../core';
import { downloadDocument, isPublicAddress } from '../source';
import { readDocumentTool } from '../assistantProtocol';

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${escaped.length + 30} >>\nstream\nBT /F1 18 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe('read_document', () => {
  it('reads CSV as a normalized table', async () => {
    const result = await readDocumentBuffer({
      buffer: Buffer.from('name,score\nAda,10\nLinus,9\n'),
      filename: 'scores.csv',
      mimeType: 'text/csv',
    });

    expect(result.type).toBe('csv');
    expect(result.sections[0]?.tables?.[0]?.rows).toEqual([
      ['name', 'score'], ['Ada', '10'], ['Linus', '9'],
    ]);
  });

  it('reads XLSX sheets and preserves formulas', async () => {
    const workbook = new ExcelJS.Workbook();
    const first = workbook.addWorksheet('Summary');
    first.addRow(['Item', 'Value']);
    first.addRow(['Total', { formula: 'SUM(B3:B3)', result: 7 }]);
    workbook.addWorksheet('Ignored').addRow(['secret']);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await readDocumentBuffer({
      buffer: bytes,
      filename: 'report.xlsx',
      mimeType: 'application/octet-stream',
    }, { sheets: ['Summary'] });

    expect(result.type).toBe('spreadsheet');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.title).toBe('Summary');
    expect(result.sections[0]?.tables?.[0]?.rows[1]?.[1]).toEqual({ formula: 'SUM(B3:B3)', result: 7 });
  });

  it('reads DOCX text and tables', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.folder('_rels')!.file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.folder('word')!.file('document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t>Revenue increased.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Q1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await readDocumentBuffer({ buffer: bytes, filename: 'report.docx', mimeType: '' });

    expect(result.type).toBe('document');
    expect(result.sections[0]?.text).toContain('Revenue increased.');
    expect(result.sections[0]?.tables?.[0]?.rows).toEqual([['Q1', '42']]);
  });

  it('extracts only semantic DOCX text and preserves body order', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document xmlns:w="w"><w:body><w:p w:rsidR="ATTRIBUTE_SECRET"><w:r><w:t>Before</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After</w:t><w:tab/><w:t>tab</w:t></w:r><w:r><w:instrText>FIELD_SECRET</w:instrText></w:r></w:p></w:body></w:document>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await readDocumentBuffer({ buffer: bytes, filename: 'ordered.docx', mimeType: '' });
    expect(result.sections[0]?.text).toBe('Before\nA\tB\nAfter\ttab');
    expect(result.sections[0]?.text).not.toMatch(/ATTRIBUTE_SECRET|FIELD_SECRET/);
  });

  it('reads selected PPTX slides and speaker notes', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:t>First slide</a:t></p:cSld></p:sld>');
    zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:t>Second slide</a:t></p:cSld></p:sld>');
    zip.file('ppt/slides/_rels/slide2.xml.rels', '<Relationships><Relationship Id="notes" Type="x/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>');
    zip.file('ppt/notesSlides/notesSlide2.xml', '<p:notes xmlns:p="p" xmlns:a="a"><p:cSld><a:t>Private note</a:t></p:cSld></p:notes>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await readDocumentBuffer({ buffer: bytes, filename: 'deck.pptx', mimeType: '' }, { slides: [2] });

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.text).toContain('Second slide');
    expect(result.sections[0]?.metadata?.notes).toContain('Private note');
  });

  it('uses PPTX presentation order and relationship-bound notes', async () => {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rIdB"/><p:sldId r:id="rIdA"/></p:sldIdLst></p:presentation>');
    zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rIdA" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rIdB" Type="x/slide" Target="slides/slide2.xml"/></Relationships>');
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t name="ATTRIBUTE_SECRET">Physical one</a:t></p:sld>');
    zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Physical two</a:t></p:sld>');
    zip.file('ppt/slides/_rels/slide2.xml.rels', '<Relationships><Relationship Id="notes" Type="x/notesSlide" Target="../notesSlides/notesSlide9.xml"/></Relationships>');
    zip.file('ppt/notesSlides/notesSlide9.xml', '<p:notes xmlns:p="p" xmlns:a="a"><a:t>Bound note</a:t></p:notes>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await readDocumentBuffer({ buffer: bytes, filename: 'ordered.pptx', mimeType: '' });
    expect(result.sections.map(section => section.text)).toEqual(['Physical two', 'Physical one']);
    expect(result.sections[0]?.metadata?.notes).toBe('Bound note');
    expect(JSON.stringify(result)).not.toContain('ATTRIBUTE_SECRET');
  });

  it('rejects highly compressed OOXML entries before extraction', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', `<w:document><w:body><w:p><w:r><w:t>${'A'.repeat(100_000)}</w:t></w:r></w:p></w:body></w:document>`);
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    await expect(readDocumentBuffer({ buffer: bytes, filename: 'bomb.docx', mimeType: '' })).rejects.toThrow(/compression ratio/i);
  });

  it('rejects OOXML entity declarations', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<!DOCTYPE x [<!ENTITY secret "leak">]><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&secret;</w:t></w:r></w:p></w:body></w:document>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(readDocumentBuffer({ buffer: bytes, filename: 'entity.docx', mimeType: '' })).rejects.toThrow(/DOCTYPE/i);
  });

  it('extracts text from a real PDF under Jest ESM', async () => {
    const result = await readDocumentBuffer({ buffer: minimalPdf('Uncodie PDF extraction test'), filename: 'fixture.pdf', mimeType: 'application/pdf' });
    expect(result.metadata.page_count).toBe(1);
    expect(result.sections[0]?.text).toContain('Uncodie PDF extraction test');
  });

  it('detects PDFs by signature even without MIME or extension', async () => {
    await expect(detectDocumentKind({ buffer: Buffer.from('%PDF-1.7'), filename: 'download', mimeType: '' })).resolves.toBe('pdf');
  });

  it('detects OOXML from its package when a signed URL has no useful filename', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(detectDocumentKind({ buffer, filename: 'download', mimeType: 'application/octet-stream' })).resolves.toBe('document');
  });

  it('blocks local URLs before fetching', async () => {
    await expect(downloadDocument('http://127.0.0.1/private.pdf')).rejects.toThrow(/private|reserved|local/i);
  });

  it.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::', '::ffff:127.0.0.1'])(
    'classifies %s as non-public', address => expect(isPublicAddress(address)).toBe(false),
  );

  it('validates tool arguments at runtime before downloading', async () => {
    const tool = readDocumentTool();
    await expect(tool.execute({ url: 'https://example.com/file.pdf', pages: [0] })).rejects.toThrow(/positive integers/i);
    await expect(tool.execute({ url: 'https://example.com/file.pdf', unexpected: true } as any)).rejects.toThrow(/unknown argument/i);
  });

  it('bounds returned text for the model context', async () => {
    const result = await readDocumentBuffer({ buffer: Buffer.from('x'.repeat(5_000)), filename: 'large.txt', mimeType: 'text/plain' }, { maxChars: 1_000 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
    expect(result.sections[0]?.text?.length).toBeGreaterThan(500);
    expect(result.truncated).toBe(true);
  });

  it('bounds the complete serialized result including PPTX notes', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Slide</a:t></p:sld>');
    zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="notes" Type="x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>');
    zip.file('ppt/notesSlides/notesSlide1.xml', `<p:notes xmlns:p="p" xmlns:a="a"><a:t>${'n'.repeat(5_000)}</a:t></p:notes>`);
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await readDocumentBuffer({ buffer: bytes, filename: 'notes.pptx', mimeType: '' }, { maxChars: 1_000 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
    expect(result.truncated).toBe(true);
  });

  it('bounds large table cells too', async () => {
    const result = await readDocumentBuffer({ buffer: Buffer.from(`column\n${'x'.repeat(5_000)}\n`), filename: 'large.csv', mimeType: 'text/csv' }, { maxChars: 1_000 });
    expect(JSON.stringify(result.sections).length).toBeLessThan(1_300);
    expect(result.truncated).toBe(true);
  });
});