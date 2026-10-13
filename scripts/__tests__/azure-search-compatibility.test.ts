import { randomBytes } from 'node:crypto';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import {
  buildProbeRequest, getProbeConfig, inspectProbeResponse, requestProbe,
} from '../azure-search-compatibility';

jest.mock('@/lib/services/search/web-search', () => ({
  ...jest.requireActual<typeof import('@/lib/services/search/web-search')>('@/lib/services/search/web-search'),
  searchWeb: jest.fn(),
}));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: {} }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));
jest.mock('scrapybara/tools', () => ({ tool: (definition: unknown) => definition }));

import { searchWeb } from '@/lib/services/search/web-search';
import { POST } from '@/app/api/agents/tools/webSearch/route';
import { webSearchTool, webSearchToolScrapybara } from '@/app/api/agents/tools/webSearch/assistantProtocol';
import { toolsRouterTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { normalizeWebSearchResponse, validateWebSearchOptions } from '@/lib/services/search/web-search';
import { NextRequest } from 'next/server';
import type { UbuntuInstance } from 'scrapybara';

// Synthetic evidence in the shape observed from Azure. No saved live response or credentials.
function fixture() {
  return {
    status: 'completed', error: null,
    output: [
      {
        type: 'web_search_call', status: 'completed',
        action: { type: 'search', sources: [
          { type: 'url', url: 'https://example.invalid/release' },
          { type: 'url', url: 'https://example.invalid/source-only' },
        ] },
        results: [{ type: 'text_result', title: 'Release schedule', url: 'https://example.invalid/release', snippet: 'Documented schedule.' }],
      },
      {
        type: 'message', status: 'completed', content: [{
          type: 'output_text', text: 'See the [release schedule](https://example.invalid/release).',
          annotations: [
            { type: 'url_citation', title: 'Release schedule', url: 'https://example.invalid/release', start_index: 8, end_index: 24 },
            { type: 'url_citation', title: 'Additional source', url: 'https://example.invalid/source-only', start_index: 0, end_index: 2 },
          ],
        }],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    tool_usage: { web_search: { num_requests: 2 } },
  };
}

describe('isolated Azure search compatibility', () => {
  it('builds a bounded non-stored request with sources and snippets', () => {
    expect(buildProbeRequest('synthetic-deployment', 'basic')).toMatchObject({
      model: 'synthetic-deployment', tools: [{ type: 'web_search' }], tool_choice: 'required',
      include: ['web_search_call.action.sources', 'web_search_call.results'],
      store: false, max_tool_calls: 1, max_output_tokens: 1800,
    });
  });

  it('tests native domain filters and strict structured output separately', () => {
    expect(buildProbeRequest('synthetic-deployment', 'domains').tools[0]).toMatchObject({
      filters: { allowed_domains: ['nodejs.org'], blocked_domains: ['github.com'] },
    });
    expect(buildProbeRequest('synthetic-deployment', 'structured').text?.format).toMatchObject({
      type: 'json_schema', strict: true,
    });
    expect(buildProbeRequest('synthetic-deployment', 'exclude').tools[0]).toMatchObject({
      filters: { blocked_domains: ['github.com'] },
    });
  });

  it('maps real evidence fields into the current formatter without losing citations', () => {
    const { data, payload, metrics } = inspectProbeResponse(fixture());
    expect(data.results).toEqual([
      { title: 'Release schedule', url: 'https://example.invalid/release', content: 'Documented schedule.' },
      { title: 'Additional source', url: 'https://example.invalid/source-only', content: '' },
    ]);
    expect(payload.results[0].snippet).toBe('Documented schedule.');
    expect(payload.text).toContain(data.answer);
    for (const item of data.results) expect(payload.text).toContain(item.url);
    expect(metrics.completedSearchCalls).toBe(1);
    expect(metrics.bingRequests).toBe(2); // Billing is not the number of output items.
  });

  it('caps results and omits the answer locally without fabricating fragments', () => {
    const { data, payload } = inspectProbeResponse(fixture(), { maxResults: 1, includeAnswer: false });
    expect(data.results).toHaveLength(1);
    expect(data.answer).toBe('');
    expect(payload.answer).toBeUndefined();
    expect(payload.text).toContain('https://example.invalid/release');
  });

  it('does not invent snippets when only sources and citations are available', () => {
    const raw = fixture();
    raw.output[0].results = [];
    expect(inspectProbeResponse(raw).data.results.every(item => item.content === '')).toBe(true);
  });

  it('does not promote an ungrounded URL in generated answer text into a search result', () => {
    const raw = fixture();
    raw.output[1].content![0].text = 'See https://unverified.example.invalid/';
    expect(inspectProbeResponse(raw).evidenceUrls).not.toContain('https://unverified.example.invalid/');
  });

  it.each(['failed', 'incomplete', 'in_progress'])('rejects response status %s', status => {
    expect(() => inspectProbeResponse({ ...fixture(), status })).toThrow('did not complete');
  });

  it('rejects an answer without a search call', () => {
    const raw = fixture();
    raw.output.shift();
    expect(() => inspectProbeResponse(raw)).toThrow('No completed web search evidence');
  });

  it('rejects an unfinished tool call even if the top-level status completed', () => {
    const raw = fixture();
    raw.output[0].status = 'failed';
    expect(() => inspectProbeResponse(raw)).toThrow('No completed web search evidence');
  });

  it('preserves a genuinely empty completed search without inventing results', () => {
    const raw = fixture();
    raw.output[0].results = [];
    raw.output[0].action!.sources = [];
    raw.output[1].content![0].annotations = [];
    expect(inspectProbeResponse(raw).data.results).toEqual([]);
  });

  it('rejects malformed responses without echoing raw content', () => {
    const marker = randomBytes(24).toString('hex');
    expect(() => inspectProbeResponse({ status: marker })).toThrow('Invalid Azure search response shape');
  });

  it.each([0, -1, 21, 1.5])('rejects invalid local result limit %s', maxResults => {
    expect(() => inspectProbeResponse(fixture(), { maxResults })).toThrow('Invalid result limit');
  });

  it('drops unsafe or credential-bearing source URLs without requesting them', () => {
    const raw = fixture();
    const url = new URL('https://example.invalid/private');
    url.username = randomBytes(10).toString('hex');
    url.password = randomBytes(16).toString('hex');
    raw.output[0].action!.sources.push(...[
      url.href, 'javascript:alert(1)', 'http://127.0.0.1/', 'http://169.254.169.254/', 'http://localhost/',
    ].map(value => ({ type: 'url', url: value })));
    const serialized = JSON.stringify(inspectProbeResponse(raw));
    expect(serialized).not.toContain(url.username);
    expect(serialized).not.toContain(url.password);
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('169.254.169.254');
    expect(serialized).not.toContain('javascript:');
  });
});

describe('probe authentication and failure boundaries (offline)', () => {
  function config() {
    return getProbeConfig({
      MICROSOFT_AZURE_OPENAI_ENDPOINT: 'https://synthetic-resource.openai.azure.com/',
      MICROSOFT_AZURE_OPENAI_API_KEY: randomBytes(32).toString('hex'),
      MICROSOFT_AZURE_OPENAI_DEPLOYMENT: 'synthetic-deployment',
    });
  }

  it('requires credentials paired with the selected endpoint', () => {
    expect(() => getProbeConfig({
      MICROSOFT_AZURE_OPENAI_ENDPOINT: 'https://synthetic-resource.openai.azure.com/',
      AZURE_OPENAI_API_KEY: randomBytes(32).toString('hex'),
      MICROSOFT_AZURE_OPENAI_DEPLOYMENT: 'synthetic-deployment',
    })).toThrow('configuration is incomplete');
  });

  it.each(['https://example.invalid/', 'http://synthetic-resource.openai.azure.com/',
    'https://synthetic-resource.openai.azure.com/openai/deployments/other',
    'https://synthetic-resource.openai.azure.com/?redirect=1'])('rejects invalid credential destination %s', endpoint => {
    expect(() => getProbeConfig({
      MICROSOFT_AZURE_OPENAI_ENDPOINT: endpoint,
      MICROSOFT_AZURE_OPENAI_API_KEY: randomBytes(32).toString('hex'),
      MICROSOFT_AZURE_OPENAI_DEPLOYMENT: 'synthetic-deployment',
    })).toThrow('Invalid Azure probe endpoint');
  });

  it('sends the credential only in the header and disables redirects', async () => {
    const settings = config();
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    await requestProbe(settings, 'basic', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).not.toContain(settings.apiKey);
    expect(init?.body).not.toContain(settings.apiKey);
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toHaveProperty('api-key', settings.apiKey);
  });

  it.each([400, 401, 403, 429, 500])('fails closed for HTTP %s without retries or secrets in errors', async status => {
    const settings = config();
    const marker = randomBytes(24).toString('hex');
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: `${marker} ${settings.apiKey} ${settings.origin}` },
    }), { status }));
    const error = await requestProbe(settings, 'basic', fetcher).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`HTTP ${status}`);
    expect(String(error)).not.toContain(settings.apiKey);
    expect(String(error)).not.toContain(settings.origin);
    expect(String(error)).not.toContain(marker);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not leak a raw transport error or retry an uncertain request', async () => {
    const settings = config();
    const fetcher = jest.fn<typeof fetch>().mockRejectedValue(new Error(settings.apiKey));
    const error = await requestProbe(settings, 'basic', fetcher).catch(value => value as Error);
    expect(String(error)).toContain('transport failed or timed out');
    expect(String(error)).not.toContain(settings.apiKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('existing consumer contracts with the experimental adapter', () => {
  const search = jest.mocked(searchWeb);
  beforeEach(() => {
    jest.clearAllMocks();
    search.mockResolvedValue({ success: true, data: normalizeWebSearchResponse(fixture(), 'public query', validateWebSearchOptions()) });
  });

  it('the current HTTP tool returns the normalized data without a route change', async () => {
    const response = await POST(new NextRequest('https://example.invalid/api/agents/tools/webSearch', {
      method: 'POST', body: JSON.stringify({ query: 'public release schedule' }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, data: { results: [{ content: 'Documented schedule.' }, {}] } });
  });

  it('both assistant wrappers keep title, URL, snippet and answer', async () => {
    const wrappers = [webSearchTool(), webSearchToolScrapybara({} as UbuntuInstance)];
    for (const wrapper of wrappers) {
      const result = await wrapper.execute({ query: 'public release schedule' });
      expect(result).toMatchObject({
        success: true,
        results: [{ title: 'Release schedule', url: 'https://example.invalid/release', snippet: 'Documented schedule.' }, {}],
      });
      expect(result.result).toContain('https://example.invalid/release');
      expect(result.answer).toContain('release schedule');
    }
  });

  it('the current tools router forwards results from the adapted assistant wrapper', async () => {
    const router = toolsRouterTool([webSearchTool()]);
    const result = await router.execute({ action: 'call', name: 'webSearch', args: JSON.stringify({ query: 'public release schedule' }) });
    expect(result.success).toBe(true);
    expect(result).toHaveProperty('results.0.url', 'https://example.invalid/release');
  });

  it('assistant answer and citation offsets remain aligned with leading whitespace', async () => {
    const raw = fixture();
    raw.output[1].content![0].text = '\nRead source.';
    raw.output[1].content![0].annotations = [{
      type: 'url_citation', title: 'Source', url: 'https://example.invalid/release', start_index: 1, end_index: 5,
    }];
    search.mockResolvedValue({ success: true, data: normalizeWebSearchResponse(raw, 'query', validateWebSearchOptions()) });
    const result = await webSearchTool().execute({ query: 'query' });
    const citation = result.citations[0];
    expect(result.answer?.slice(citation.start_index, citation.end_index)).toBe('Read');
  });

  it('provider failure remains an error instead of a successful empty search', async () => {
    search.mockResolvedValue({ success: false, error: 'Azure search unavailable', error_status: 502 });
    const response = await POST(new NextRequest('https://example.invalid/api/agents/tools/webSearch', {
      method: 'POST', body: JSON.stringify({ query: 'public release schedule' }),
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ success: false });
    await expect(webSearchTool().execute({ query: 'public release schedule' })).rejects.toThrow('Azure search unavailable');
  });
});