import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { normalizeWebSearchResponse, validateWebSearchOptions } from '@/lib/services/search/web-search';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: {
    PRICING: { WEB_SEARCH: 0.1 },
    validateCredits: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    deductCredits: jest.fn<() => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
  },
}));
jest.mock('@/lib/utils/html-utils', () => ({ fetchHtml: jest.fn() }));
jest.mock('@/lib/utils/html-content-cleaner', () => ({ cleanHtmlContent: jest.fn() }));
jest.mock('uuid', () => ({ v4: () => require('node:crypto').randomUUID() }));

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeMultipleSearches } from '@/lib/services/search/data-analyst-search';
import { POST } from '@/app/api/agents/dataAnalyst/search/route';
import { GoogleSearchService } from '@/lib/services/google-search-service';
import { DuckDuckGoSearchService } from '@/lib/services/duckduckgo-search-service';
import { CreditService } from '@/lib/services/billing/CreditService';
import { POST as webSearchPost } from '@/app/api/agents/tools/webSearch/route';
import { NextRequest } from 'next/server';
import type { GoogleSearchOptions, GoogleSearchResponse } from '@/lib/services/google-search-service';
import type { DuckDuckGoSearchOptions, DuckDuckGoSearchResponse } from '@/lib/services/duckduckgo-search-service';

describe('Data Analyst, Deep Research helper, and fallback payload compatibility', () => {
  const siteId = randomUUID();
  const agentId = randomUUID();
  const memoryId = randomUUID();
  const userId = randomUUID();
  const names = ['MICROSOFT_AZURE_OPENAI_ENDPOINT', 'MICROSOFT_AZURE_OPENAI_API_KEY', 'MICROSOFT_AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_SEARCH_ENDPOINT', 'AZURE_OPENAI_SEARCH_API_KEY', 'AZURE_OPENAI_SEARCH_DEPLOYMENT'];
  const oldEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const raw = {
    status: 'completed', output: [{
      type: 'web_search_call', status: 'completed', action: { type: 'search' },
      results: [{ type: 'text_result', title: 'Public source', url: 'https://example.invalid/source', snippet: 'Source evidence.' }],
    }, {
      type: 'message', content: [{ type: 'output_text', text: 'Grounded answer.' }],
    }],
  };
  const normalized = normalizeWebSearchResponse(raw, 'public query', validateWebSearchOptions());
  const insert = jest.fn();

  beforeEach(() => {
    for (const name of names) delete process.env[name];
    process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT = 'https://synthetic-resource.openai.azure.com/';
    process.env.MICROSOFT_AZURE_OPENAI_API_KEY = randomBytes(32).toString('hex');
    process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT = 'synthetic-deployment';
    insert.mockClear();
    jest.mocked(CreditService.deductCredits).mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(raw)));
    // No database or account writes: exercise only the unchanged consumers' payload contract.
    jest.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
      const chain = {
        select: jest.fn(), eq: jest.fn(), insert,
        single: jest.fn(async () => ({ data: table === 'agents' ? { id: agentId, user_id: userId } : { id: memoryId }, error: null })),
      };
      chain.select.mockReturnValue(chain);
      chain.eq.mockReturnValue(chain);
      insert.mockReturnValue(chain);
      return chain;
    }) as unknown as typeof supabaseAdmin.from);
  });

  afterEach(() => {
    for (const name of names) {
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
    }
    jest.restoreAllMocks();
  });

  it('the multiple-search helper used by Deep Research preserves answer, counts and memories', async () => {
    const result = await executeMultipleSearches(siteId, ['public query'], {}, agentId);
    expect(result).toMatchObject({ success: true, data: {
      successful_searches: 1, memory_ids: [memoryId],
      search_results: [{ answer: normalized.answer, results_count: 1 }],
    } });
    expect(insert).toHaveBeenCalledWith([expect.objectContaining({
      data: expect.objectContaining({ results: normalized.results, answer: normalized.answer }),
    })]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Data Analyst uses the shared Azure service and preserves its API contract', async () => {
    const result = await POST(new Request('https://example.invalid/api/agents/dataAnalyst/search', {
      method: 'POST', body: JSON.stringify({ site_id: siteId, agent_id: agentId, search_queries: ['public query'] }),
    }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ success: true, data: {
      successful_searches: 1, search_results: [{ answer: normalized.answer, results_count: 1 }],
    } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([5, 10])('the unchanged nested workflow request accepts legacy limit=%s', async limit => {
    const response = await POST(new Request('https://example.invalid/api/agents/dataAnalyst/search', {
      method: 'POST', body: JSON.stringify({ site_id: siteId, agent_id: agentId,
        operation: { search_queries: ['query'], search_options: { limit } },
      }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { successful_searches: 1 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('the direct HTTP tool accepts limit without changing its default or ignoring conflicts', async () => {
    jest.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ ...raw, output: [
      { ...raw.output[0], results: Array.from({ length: 7 }, (_, i) => ({
        type: 'text_result', url: `https://example.invalid/${i}`, title: String(i), snippet: 'Evidence.',
      })) }, raw.output[1],
    ] })));
    for (const [options, count] of [[{ limit: 3 }, 3], [{}, 5]] as const) {
      const response = await webSearchPost(new NextRequest('https://example.invalid/api/agents/tools/webSearch', {
        method: 'POST', body: JSON.stringify({ query: 'query', ...options }),
      }));
      expect(response.status).toBe(200);
      expect((await response.json()).data.results).toHaveLength(count);
    }
    jest.mocked(fetch).mockClear();
    const response = await webSearchPost(new NextRequest('https://example.invalid/api/agents/tools/webSearch', {
      method: 'POST', body: JSON.stringify({ query: 'query', limit: 3, max_results: 5 }),
    }));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  function stubGooglePrimary(service: GoogleSearchService) {
    const fields = service as unknown as { googleApiKey: string; googleCseId: string; serpApiKey?: string };
    fields.googleApiKey = 'synthetic-selector'; fields.googleCseId = 'synthetic-selector'; fields.serpApiKey = undefined;
    return jest.spyOn(service as unknown as { searchWithGoogle(options: GoogleSearchOptions): Promise<GoogleSearchResponse> }, 'searchWithGoogle')
      .mockRejectedValue(new Error('Synthetic primary failure'));
  }

  function stubDuckPrimary(service: DuckDuckGoSearchService) {
    const empty: DuckDuckGoSearchResponse = { success: false, results: [], query: '', totalResults: 0 };
    const methods = service as unknown as {
      searchWithInstantApi(options: DuckDuckGoSearchOptions): Promise<DuckDuckGoSearchResponse>;
      searchDuckDuckGoDirectly(options: DuckDuckGoSearchOptions): Promise<DuckDuckGoSearchResponse>;
    };
    const instant = jest.spyOn(methods, 'searchWithInstantApi').mockResolvedValue(empty);
    jest.spyOn(methods, 'searchDuckDuckGoDirectly').mockResolvedValue(empty);
    return instant;
  }

  function stubNewsEvidence() {
    jest.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const host = body.tools[0].filters?.allowed_domains?.[0] ?? 'example.invalid';
      return new Response(JSON.stringify({ ...raw, output: [{ ...raw.output[0],
        results: Array.from({ length: 25 }, (_, i) => ({ type: 'text_result',
          url: `https://${host}/source-${i}`, title: `Source ${i}`, snippet: 'Source evidence.',
        })),
      }, raw.output[1]] }));
    });
  }

  it.each(['LLM', 'general'] as const)('Google %s news defaults reach Azure but retain primary preferences', async kind => {
    const service = new GoogleSearchService();
    const primary = stubGooglePrimary(service);
    stubNewsEvidence();
    const result = kind === 'LLM' ? await service.searchLLMNews({}) : await service.searchNews({ topic: 'public news' });
    expect(result).toMatchObject({ success: true, method: 'azure_bing' });
    expect(result.results).toHaveLength(20);
    expect(primary).toHaveBeenCalledWith(expect.objectContaining({ country: 'us' }));
    if (kind === 'LLM') expect(primary).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['LLM', 'general'] as const)('DuckDuckGo %s news defaults reach Azure but retain primary region', async kind => {
    const service = new DuckDuckGoSearchService();
    const primary = stubDuckPrimary(service);
    stubNewsEvidence();
    const result = kind === 'LLM' ? await service.searchLLMNews({}) : await service.searchNews({ topic: 'public news' });
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(20);
    expect(primary).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-en' }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caps larger legacy helper requests to Azure capacity instead of rejecting them', async () => {
    const google = new GoogleSearchService(); stubGooglePrimary(google);
    const duck = new DuckDuckGoSearchService(); stubDuckPrimary(duck);
    stubNewsEvidence();
    expect((await google.searchLLMNews({ maxResults: 50 })).results).toHaveLength(20);
    expect((await duck.searchNews({ topic: 'news', maxResults: 30 })).results).toHaveLength(20);
  });

  it('news helpers do not discard explicit locale or hard date requirements', async () => {
    const google = new GoogleSearchService(); stubGooglePrimary(google);
    const duck = new DuckDuckGoSearchService(); stubDuckPrimary(duck);
    expect(await google.searchLLMNews({ language: 'es' })).toMatchObject({ success: false });
    expect(await google.searchNews({ topic: 'news', dateFrom: '2026-01-01' })).toMatchObject({ success: false });
    expect(await duck.searchLLMNews({ region: 'mx-es' })).toMatchObject({ success: false });
    expect(await duck.searchNews({ topic: 'news', dateTo: '2026-01-01' })).toMatchObject({ success: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Google multi-source news uses a positive per-source limit and working fallbacks', async () => {
    const google = new GoogleSearchService(); stubGooglePrimary(google);
    stubNewsEvidence();
    const result = await google.searchNews({ topic: 'news', sources: ['one.invalid', 'two.invalid'], maxResults: 1 });
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('Data Analyst rejects unsupported options before internal charging or provider requests', async () => {
    const response = await POST(new Request('https://example.invalid/api/agents/dataAnalyst/search', {
      method: 'POST', body: JSON.stringify({ site_id: siteId, agent_id: agentId, search_queries: ['query'], search_options: { include_images: true } }),
    }));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });

  it('stores accurate new provider metadata and reports the existing rate', async () => {
    await POST(new Request('https://example.invalid/api/agents/dataAnalyst/search', {
      method: 'POST', body: JSON.stringify({ site_id: siteId, agent_id: agentId, search_queries: ['query'] }),
    }));
    expect(CreditService.deductCredits).toHaveBeenCalledWith(siteId, 0.1, 'web_search', expect.any(String), expect.objectContaining({ provider: 'azure_bing' }));
    expect(insert).toHaveBeenCalledWith([expect.objectContaining({ metadata: expect.objectContaining({ source: 'web_search', search_engine: 'azure_bing' }) })]);
  });

  it('rejects unsupported date options at both fallback boundaries without Azure calls', async () => {
    await expect(new GoogleSearchService()['searchWithWebSearchFallback']({ query: 'query', dateFrom: '2026-01-01' })).rejects.toThrow('does not support');
    expect(await new DuckDuckGoSearchService()['searchWithWebSearchFallback']({ query: 'query', dateTo: '2026-01-01' })).toMatchObject({ success: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported locale options at fallback boundaries without Azure calls', async () => {
    await expect(new GoogleSearchService()['searchWithWebSearchFallback']({ query: 'query', language: 'es' })).rejects.toThrow('country/language');
    expect(await new DuckDuckGoSearchService()['searchWithWebSearchFallback']({ query: 'query', region: 'mx-es' })).toMatchObject({ success: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not charge when the Azure configuration is incomplete', async () => {
    delete process.env.MICROSOFT_AZURE_OPENAI_API_KEY;
    const response = await POST(new Request('https://example.invalid/api/agents/dataAnalyst/search', {
      method: 'POST', body: JSON.stringify({ site_id: siteId, agent_id: agentId, search_queries: ['query'] }),
    }));
    expect(response.status).toBe(503);
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never retries the Azure fallback through Google orchestration', async () => {
    const service = new GoogleSearchService();
    const fields = service as unknown as { googleApiKey: string; googleCseId: string; serpApiKey?: string };
    fields.googleApiKey = ''; fields.googleCseId = ''; fields.serpApiKey = undefined;
    jest.mocked(fetch).mockResolvedValue(new Response('upstream failure', { status: 500 }));
    expect(await service.search({ query: 'query' })).toMatchObject({ success: false, method: 'azure_bing' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('the Google fallback keeps the result title, URL, domain and snippet', async () => {
    // Exercise the fallback boundary directly; do not run Google/SerpAPI providers.
    const result = await new GoogleSearchService()['searchWithWebSearchFallback']({ query: 'public query' });
    expect(result).toMatchObject({ success: true, results: [{
      title: 'Public source', url: 'https://example.invalid/source', domain: 'example.invalid', snippet: 'Source evidence.',
    }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('the DuckDuckGo fallback keeps its URL-only result contract', async () => {
    const result = await new DuckDuckGoSearchService()['searchWithWebSearchFallback']({ query: 'public query' });
    expect(result).toMatchObject({ success: true, results: [{
      title: 'Public source', url: 'https://example.invalid/source', domain: 'example.invalid',
    }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});