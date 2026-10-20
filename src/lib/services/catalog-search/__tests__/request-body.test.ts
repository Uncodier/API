import { CatalogBodyTooLargeError, readCatalogJson } from '../request-body';

describe('catalog body budgets', () => {
  it('counts UTF8 bytes even without declared content-length', async () => {
    const body = JSON.stringify({ q: '😀'.repeat(20) });
    const request = new Request('https://example.invalid', { method: 'POST', body });
    await expect(readCatalogJson(request, 60)).rejects.toBeInstanceOf(CatalogBodyTooLargeError);
  });
  it('rejects invalid JSON and accepts a bounded document', async () => {
    await expect(readCatalogJson(new Request('https://example.invalid', { method: 'POST', body: '{' }), 10)).rejects.toBeInstanceOf(SyntaxError);
    await expect(readCatalogJson(new Request('https://example.invalid', { method: 'POST', body: '{"q":"shoe"}' }), 30)).resolves.toEqual({ q: 'shoe' });
  });
});