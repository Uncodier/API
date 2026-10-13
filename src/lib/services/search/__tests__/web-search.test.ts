import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  buildWebSearchRequest, getWebSearchConfig, normalizeWebSearchResponse, searchWeb,
  validateWebSearchOptions, WebSearchError,
} from '../web-search';

interface FixtureCitation { type: string; title: string; url: string; start_index: number; end_index: number }
interface FixturePart { type: string; text: string; annotations?: FixtureCitation[] }
interface FixtureItem {
  type: string; status?: string; content?: FixturePart[];
  action?: { type: string; sources: Array<{ type: string; url: string }> };
  results?: Array<{ type: string; url: string; title: string; snippet: string }>;
}
function fixture(): {
  id: string; status: string; error: null; output: FixtureItem[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  tool_usage: { web_search: { num_requests: number } };
} {
  return {
    id: 'synthetic-response', status: 'completed', error: null,
    output: [{
    type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Synthetic reasoning.', annotations: [] }],
    }, {
      type: 'web_search_call', status: 'completed',
      action: { type: 'search', sources: [
        { type: 'url', url: 'https://example.invalid/schedule' },
        { type: 'url', url: 'https://example.invalid/policy' },
      ] },
      results: [{ type: 'text_result', url: 'https://example.invalid/schedule', title: 'Schedule', snippet: 'Source snippet.' }],
    }, {
      type: 'message', status: 'completed', content: [{
        type: 'output_text', text: 'Read the schedule.', annotations: [{
          type: 'url_citation', title: 'Policy', url: 'https://example.invalid/policy', start_index: 0, end_index: 4,
        }],
      }],
    }],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    tool_usage: { web_search: { num_requests: 2 } },
  };
}

describe('web search request and configuration', () => {
  const key = randomBytes(32).toString('hex');
  const base = {
    MICROSOFT_AZURE_OPENAI_ENDPOINT: 'https://synthetic-resource.openai.azure.com/',
    MICROSOFT_AZURE_OPENAI_API_KEY: key,
    MICROSOFT_AZURE_OPENAI_DEPLOYMENT: 'synthetic-deployment',
  };

  it('uses the existing direct Azure configuration without exposing credentials', () => {
    expect(getWebSearchConfig(base)).toEqual({ origin: 'https://synthetic-resource.openai.azure.com', apiKey: key, deployment: 'synthetic-deployment' });
  });

  it('allows a complete dedicated search override', () => {
    expect(getWebSearchConfig({ ...base,
      AZURE_OPENAI_SEARCH_ENDPOINT: 'https://search-resource.openai.azure.com/openai/v1/',
      AZURE_OPENAI_SEARCH_API_KEY: key, AZURE_OPENAI_SEARCH_DEPLOYMENT: 'search-deployment',
    }).deployment).toBe('search-deployment');
  });

  it.each([
    { AZURE_OPENAI_SEARCH_ENDPOINT: '' },
    { AZURE_OPENAI_SEARCH_ENDPOINT: 'https://search-resource.openai.azure.com/' },
    { AZURE_OPENAI_SEARCH_API_KEY: key },
    { AZURE_OPENAI_SEARCH_DEPLOYMENT: '' },
    { MICROSOFT_AZURE_OPENAI_API_KEY: '' },
  ])('fails closed for incomplete/empty selected overrides', override => {
    expect(() => getWebSearchConfig({ ...base, ...override })).toThrow(WebSearchError);
  });

  it('supports generic Azure only when no Microsoft or dedicated pair is selected', () => {
    expect(getWebSearchConfig({ AZURE_OPENAI_ENDPOINT: base.MICROSOFT_AZURE_OPENAI_ENDPOINT,
      AZURE_OPENAI_API_KEY: key, AZURE_OPENAI_DEPLOYMENT: 'generic-deployment',
    }).deployment).toBe('generic-deployment');
  });

  it('does not pair a Microsoft endpoint with a generic gateway key', () => {
    expect(() => getWebSearchConfig({ ...base, MICROSOFT_AZURE_OPENAI_API_KEY: undefined, AZURE_OPENAI_API_KEY: key })).toThrow('not configured');
  });

  it.each(['http://synthetic-resource.openai.azure.com/', 'https://example.invalid/',
    'https://synthetic-resource.openai.azure.com/openai/deployments/other',
    'https://synthetic-resource.openai.azure.com/?token=1', 'https://synthetic-resource.openai.azure.com/#fragment',
    'https://synthetic-resource.openai.azure.com:8443/'])('rejects invalid endpoint %s', endpoint => {
    expect(() => getWebSearchConfig({ ...base, MICROSOFT_AZURE_OPENAI_ENDPOINT: endpoint })).toThrow('endpoint configuration');
  });

  it.each(['vendor/deployment', '../other', 'name with spaces'])('rejects invalid deployment %s', deployment => {
    expect(() => getWebSearchConfig({ ...base, MICROSOFT_AZURE_OPENAI_DEPLOYMENT: deployment })).toThrow('deployment configuration');
  });

  it('normalizes/deduplicates domain filters and puts the query in data, not system instructions', () => {
    const options = validateWebSearchOptions({ include_domains: ['https://Example.Invalid/', 'example.invalid'], exclude_domains: ['blocked.example.invalid'] });
    const request = buildWebSearchRequest('  public query  ', options, 'synthetic');
    expect(request.input).toBe('public query');
    expect(request.instructions).not.toContain('public query');
    expect(request.tools[0]).toMatchObject({ type: 'web_search', filters: {
      allowed_domains: ['example.invalid'], blocked_domains: ['blocked.example.invalid'],
    } });
    expect(request).toMatchObject({ tool_choice: 'required', max_tool_calls: 1, store: false });
  });

  it.each<{ search_depth: 'basic' | 'advanced' | 'comprehensive'; max_tool_calls: number; effort: string }>([
    { search_depth: 'basic', max_tool_calls: 1, effort: 'low' },
    { search_depth: 'advanced', max_tool_calls: 2, effort: 'medium' },
    { search_depth: 'comprehensive', max_tool_calls: 3, effort: 'medium' },
  ])('bounds $search_depth search effort', ({ search_depth, max_tool_calls, effort }) => {
    expect(buildWebSearchRequest('query', validateWebSearchOptions({ search_depth }), 'synthetic')).toMatchObject({ max_tool_calls, reasoning: { effort } });
  });

  it.each([{ include_images: true }, { days: 3 }, { dateFrom: '2026-01-01' }, { include_raw_content: true },
    { max_results: 0 }, { max_results: 21 }, { max_results: 1.5 }, { search_depth: 'unknown' }])('rejects unsupported or invalid options', options => {
    expect(() => validateWebSearchOptions(options)).toThrow('Invalid or unsupported');
  });

  it.each(['127.0.0.1', 'localhost', 'internal.local', 'https://example.invalid/path', 'example.invalid:8443',
    '*.example.invalid', 'https://example.invalid/?q=1'])('rejects invalid domain filter %s', domain => {
    expect(() => validateWebSearchOptions({ include_domains: [domain] })).toThrow();
  });

  it('rejects an allow list entirely covered by the block list', () => {
    expect(() => validateWebSearchOptions({ include_domains: ['sub.example.invalid'], exclude_domains: ['example.invalid'] })).toThrow('exclude every');
  });

  it.each([5, 10, 20])('normalizes legacy workflow limit=%s to max_results', limit => {
    const options = validateWebSearchOptions({ limit });
    expect(options.max_results).toBe(limit);
    expect(options).not.toHaveProperty('limit');
    expect(validateWebSearchOptions(options)).toEqual(options);
  });

  it('accepts matching aliases and rejects conflicting aliases without ignoring either', () => {
    expect(validateWebSearchOptions({ limit: 5, max_results: 5 }).max_results).toBe(5);
    expect(() => validateWebSearchOptions({ limit: 5, max_results: 10 })).toThrow('Invalid or unsupported');
  });

  it.each([0, -1, 21, 1.5, '5', null])('rejects invalid legacy limit=%s', limit => {
    expect(() => validateWebSearchOptions({ limit })).toThrow('Invalid or unsupported');
  });

  it.each(['', '   ', 'x'.repeat(8001)])('rejects invalid queries before request', query => {
    expect(() => buildWebSearchRequest(query, validateWebSearchOptions(), 'synthetic')).toThrow('query must');
  });
});

describe('deterministic Azure evidence normalization', () => {
  it('uses snippets rather than generated summaries and retains citations and actual billing usage', () => {
    const result = normalizeWebSearchResponse(fixture(), 'query', validateWebSearchOptions());
    expect(result.results).toEqual([
      { title: 'Schedule', url: 'https://example.invalid/schedule', content: 'Source snippet.' },
      { title: 'Policy', url: 'https://example.invalid/policy', content: '' },
    ]);
    expect(result.citations[0]).toMatchObject({ title: 'Policy', start_index: 0, end_index: 4 });
    expect(result.tool_usage?.web_search?.num_requests).toBe(2);
    expect(result.provider).toBe('azure_bing');
    expect(result).not.toHaveProperty('results.0.score');
  });

  it('caps results without dropping cited sources outside the local result limit', () => {
    const result = normalizeWebSearchResponse(fixture(), 'query', validateWebSearchOptions({ max_results: 1 }));
    expect(result.results).toHaveLength(1);
    expect(result.citations[0].url).toBe('https://example.invalid/policy');
    expect(result.sources).toHaveLength(2);
  });

  it('omits the answer and its offsets when include_answer is false', () => {
    const result = normalizeWebSearchResponse(fixture(), 'query', validateWebSearchOptions({ include_answer: false }));
    expect(result.answer).toBeUndefined();
    expect(result.citations).toEqual([]);
    expect(result.sources).toHaveLength(2);
  });

  it('adjusts citation offsets when joining multiple text parts', () => {
    const raw = fixture();
    raw.output[2].content!.push({ type: 'output_text', text: 'More.', annotations: [{
      type: 'url_citation', title: 'Policy', url: 'https://example.invalid/policy', start_index: 0, end_index: 4,
    }] });
    const result = normalizeWebSearchResponse(raw, 'query', validateWebSearchOptions());
    expect(result.answer).toBe('Read the schedule.\nMore.');
    expect(result.citations[1].start_index).toBe('Read the schedule.\n'.length);
  });

  it('rejects provider evidence outside native allow/block filters', () => {
    expect(() => normalizeWebSearchResponse(fixture(), 'query', validateWebSearchOptions({ exclude_domains: ['example.invalid'] }))).toThrow('outside');
    expect(() => normalizeWebSearchResponse(fixture(), 'query', validateWebSearchOptions({ include_domains: ['other.invalid'] }))).toThrow('outside');
  });

  it.each(['failed', 'incomplete', 'in_progress'])('rejects incomplete status %s', status => {
    expect(() => normalizeWebSearchResponse({ ...fixture(), status }, 'query', validateWebSearchOptions())).toThrow('did not complete');
  });

  it('rejects an answer without search evidence', () => {
    const raw = fixture();
    raw.output.splice(1, 1);
    expect(() => normalizeWebSearchResponse(raw, 'query', validateWebSearchOptions())).toThrow('no completed search evidence');
  });

  it('fails closed for refusals and invalid citations', () => {
    const raw = fixture();
    raw.output[2].content![0].type = 'refusal';
    expect(() => normalizeWebSearchResponse(raw, 'query', validateWebSearchOptions())).toThrow('refused');
    raw.output[2].content![0].type = 'output_text';
    raw.output[2].content![0].annotations![0].url = 'javascript:alert(1)';
    expect(() => normalizeWebSearchResponse(raw, 'query', validateWebSearchOptions())).toThrow('unsafe citation');
  });
});

describe('production searchWeb transport (offline)', () => {
  const names = ['AZURE_OPENAI_SEARCH_ENDPOINT', 'AZURE_OPENAI_SEARCH_API_KEY', 'AZURE_OPENAI_SEARCH_DEPLOYMENT',
    'MICROSOFT_AZURE_OPENAI_ENDPOINT', 'MICROSOFT_AZURE_OPENAI_API_KEY', 'MICROSOFT_AZURE_OPENAI_DEPLOYMENT'];
  const oldEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const key = randomBytes(32).toString('hex');
  beforeEach(() => {
    for (const name of names) delete process.env[name];
    process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT = 'https://synthetic-resource.openai.azure.com/';
    process.env.MICROSOFT_AZURE_OPENAI_API_KEY = key;
    process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT = 'synthetic-deployment';
  });
  afterEach(() => {
    for (const name of names) {
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
    }
    jest.restoreAllMocks();
  });

  it('submits one native search request with no credentials in URL/body and no fallback', async () => {
    const mock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(fixture())));
    const result = await searchWeb('query', { max_results: 1 });
    expect(result.success).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, request] = mock.mock.calls[0];
    expect(String(url)).toBe('https://synthetic-resource.openai.azure.com/openai/v1/responses');
    expect(String(url)).not.toContain(key);
    expect(request?.body).not.toContain(key);
    expect(request?.headers).toHaveProperty('api-key', key);
    expect(request?.redirect).toBe('error');
    expect(request?.cache).toBe('no-store');
  });

  it.each([400, 401, 403, 429, 500])('does not retry HTTP %s or echo provider body/credentials', async status => {
    const marker = randomBytes(16).toString('hex');
    const mock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`${marker} ${key}`, { status }));
    const result = await searchWeb('query');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('validates unsupported options before network or configuration use', async () => {
    const mock = jest.spyOn(globalThis, 'fetch');
    expect(await searchWeb('query', { include_images: true })).toMatchObject({ success: false, error_status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it('fails closed for oversized and non-JSON responses', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
      .mockResolvedValueOnce(new Response('not JSON'));
    expect(await searchWeb('query')).toMatchObject({ success: false, error: expect.stringContaining('size limit') });
    expect(await searchWeb('query')).toMatchObject({ success: false, error: expect.stringContaining('non-JSON') });
  });

  it('suppresses raw transport errors, never leaks credentials, and submits no retry', async () => {
    const mock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(key));
    const result = await searchWeb('query');
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('no retry') });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});