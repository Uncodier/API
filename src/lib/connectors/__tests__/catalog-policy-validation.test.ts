import { listSelectedCatalogMetadata, validateCatalogToolIds } from '../composio-tool-metadata';
import { createComposioClient } from '../composio-transport';
import { ConnectorError } from '../types';
import { jsonResponse, secret, toolFixture } from './composio-fixtures';

const row = { ...toolFixture(), name: 'Fetch emails' };
const ids = [row.slug];
it.each([
  [{ items: [] }, 'TOOL_NOT_IN_CATALOG'],
  [{ items: [{ ...row, toolkit: { slug: 'hubspot' } }] }, 'TOOL_NOT_IN_CATALOG'],
  [{ items: [{ ...row, is_deprecated: true }] }, 'TOOL_NOT_IN_CATALOG'],
  [{ items: [{ ...row, deprecated: { is_deprecated: true } }] }, 'TOOL_NOT_IN_CATALOG'],
  [{ items: [{ ...row, is_deprecated: undefined }] }, 'PROVIDER_INVALID_RESPONSE'],
  [{ items: [{ ...row, slug: `${row.slug}_V2` }] }, 'PROVIDER_INVALID_RESPONSE'],
  [{ items: [row, row] }, 'PROVIDER_INVALID_RESPONSE'],
  [{ items: [row], total_items: 3 }, 'PROVIDER_INVALID_RESPONSE'],
  [{ items: [row], next_cursor: 'more' }, 'PROVIDER_INVALID_RESPONSE'],
])('rejects ineligible or ambiguous lookup %j without retry', async (response, code) => {
  const request = jest.fn().mockResolvedValue(response);
  await expect(validateCatalogToolIds({ request }, 'gmail', ids)).rejects.toMatchObject({ code });
  expect(request).toHaveBeenCalledTimes(1);
});

it('validates 100 exact maximum-length IDs in bounded GET batches with one transient retry', async () => {
  const selected = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'X'.repeat(147)}`);
  const key = secret();
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({}, 503));
  const seen: string[] = [];
  fetch.mockImplementation(async (url, init) => {
    const { origin, pathname, searchParams } = new URL(String(url));
    expect([origin, pathname, init?.method]).toEqual(['https://backend.composio.dev', '/api/v3.1/tools', 'GET']);
    expect(init?.headers).toMatchObject({ 'x-api-key': key });
    expect(searchParams.get('include_deprecated')).toBe('false');
    expect(searchParams.get('toolkit_slug')).toBe('gmail');
    const batch = searchParams.get('tool_slugs')!.split(','); seen.push(...batch);
    expect(batch.length).toBeLessThanOrEqual(12);
    return jsonResponse({ items: batch.map(slug => ({ ...row, slug })), total_items: batch.length });
  });
  try {
    await validateCatalogToolIds(createComposioClient(key), 'gmail', selected);
    expect(seen).toEqual(selected);
    expect(fetch).toHaveBeenCalledTimes(10);
  } finally { fetch.mockRestore(); }
});

it('shares the single retry across batches, never retries denied or rate-limited reads', async () => {
  const selected = Array.from({ length: 13 }, (_, i) => `A${i}`);
  const failure = new ConnectorError('PROVIDER_TIMEOUT', 'Timed out', 504);
  const request = jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ items: selected.slice(0, 12).map(slug => ({ ...row, slug })) }).mockRejectedValue(failure);
  await expect(validateCatalogToolIds({ request }, 'gmail', selected)).rejects.toBe(failure);
  expect(request).toHaveBeenCalledTimes(3);
  for (const code of ['PROVIDER_RATE_LIMITED', 'PROVIDER_AUTH_FAILED']) {
    request.mockReset().mockRejectedValue(new ConnectorError(code, 'Unavailable', 502));
    await expect(validateCatalogToolIds({ request }, 'gmail', ids)).rejects.toMatchObject({ code });
    expect(request).toHaveBeenCalledTimes(1);
  }
});


test('selected catalog discovery checks exact parent and returns only current provider metadata',async()=>{
  const request=jest.fn().mockResolvedValueOnce({items:[row],next_cursor:null,total_items:1});
  expect(await listSelectedCatalogMetadata({request},'gmail',[row.slug,'MAIL_REMOVED'])).toMatchObject({items:[{slug:row.slug}],missing:true});
  const url=new URL(request.mock.calls[0][0],'https://example.test');
  expect(url.searchParams.get('tool_slugs')).toBe([row.slug,'MAIL_REMOVED'].join(','));
  request.mockResolvedValueOnce({items:[{...row,toolkit:{slug:'other'}}],total_items:1});
  await expect(listSelectedCatalogMetadata({request},'gmail',[row.slug])).rejects.toMatchObject({code:'PROVIDER_INVALID_RESPONSE'});
});
