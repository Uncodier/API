import { getDocumentProxy } from 'unpdf';
import { readPdf } from '../pdf';
import { isolatedPdfImages } from '../pdf-isolation';

jest.mock('unpdf', () => ({ getDocumentProxy: jest.fn() }));
jest.mock('../pdf-isolation', () => ({ isolatedPdfImages: jest.fn() }));

describe('PDF fallback isolation and lifecycle', () => {
  const cleanup = jest.fn();
  const destroy = jest.fn();
  const getTextContent = jest.fn();
  const getPage = jest.fn();
  beforeEach(() => {
    jest.resetAllMocks();
    getTextContent.mockResolvedValue({ items: [] });
    getPage.mockResolvedValue({ getTextContent, cleanup });
    (getDocumentProxy as jest.Mock).mockResolvedValue({ numPages: 1, getPage, loadingTask: { destroy } });
    (isolatedPdfImages as jest.Mock).mockResolvedValue({ images: [], warnings: [], truncated: false });
  });

  it('never enables image decoding in the API process', async () => {
    await readPdf(Buffer.from('pdf'), {});
    expect(getDocumentProxy).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({ maxImageSize: 0, useWasm: false }));
    expect(isolatedPdfImages).toHaveBeenCalledWith(Buffer.from('pdf'), [1]);
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan((isolatedPdfImages as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('preserves text and reports unavailable images when the child fails or is unsupported', async () => {
    (isolatedPdfImages as jest.Mock).mockRejectedValue(new Error('Resource limit'));
    const result = await readPdf(Buffer.from('pdf'), {});
    expect(result.images).toBeUndefined();
    expect(result.warnings.join(' ')).toMatch(/could not be decoded safely/);
    expect(result.truncated).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('does not start the child for text-only pages', async () => {
    getTextContent.mockResolvedValue({ items: [{ str: 'Readable', hasEOL: true }] });
    expect((await readPdf(Buffer.from('pdf'), {})).sections[0].text).toBe('Readable');
    expect(isolatedPdfImages).not.toHaveBeenCalled();
  });

  it('cleans up after text extraction fails', async () => {
    getTextContent.mockRejectedValue(new Error('Text failure'));
    await expect(readPdf(Buffer.from('pdf'), {})).rejects.toThrow('Text failure');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(isolatedPdfImages).not.toHaveBeenCalled();
  });
});