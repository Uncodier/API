import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { consolidateSearchMemories, formatSearchMemoryAttribution, getSearchAnswerAttribution } from '../search-memory-data';
import { normalizeWebSearchResponse, validateWebSearchOptions } from '../../search/web-search';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/agentbase', () => ({
  CommandFactory: { createCommand: jest.fn((data: unknown) => data) },
  ProcessorInitializer: { getInstance: () => ({
    initialize: jest.fn(), getCommandService: () => ({ submitCommand: jest.fn(async () => 'synthetic-command') }),
  }) },
}));
jest.mock('@/lib/helpers/command-utils', () => ({ waitForCommandCompletion: jest.fn(async () => ({
  completed: true, command: { results: [{ research_analysis: { executive_summary: 'Synthetic analysis' } }] },
})) }));
jest.mock('@/lib/agentbase/services/command/waitForSubmittedCommand', () => ({ waitForSubmittedCommand: jest.fn(async () => ({
  commandId: 'synthetic-command', command: { status: 'completed', results: [{ research_analysis: { executive_summary: 'Synthetic analysis' } }] },
})) }));
jest.mock('@/app/api/agents/tools/report/assistantProtocol', () => ({ reportTool: () => ({ name: 'report', description: 'Synthetic report' }) }));
jest.mock('uuid', () => ({ v4: () => require('node:crypto').randomUUID() }));

import { executeDataAnalysis, consolidateSearchMemories as sharedConsolidation } from '../data-analyst-analysis';
import { POST as analysisPost } from '@/app/api/agents/dataAnalyst/analysis/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CommandFactory } from '@/lib/agentbase';

function memoryFixture() {
  const normalized = normalizeWebSearchResponse({
    status: 'completed', output: [{
      type: 'web_search_call', status: 'completed', action: { type: 'search' },
      results: [{ title: 'First', url: 'https://example.invalid/first', snippet: 'First result.' }],
    }, {
      type: 'message', content: [{
        type: 'output_text', text: '\nA sourced finding with annotation-only attribution.',
        annotations: [{ type: 'url_citation', title: 'Cited policy', url: 'https://example.invalid/cited', start_index: 1, end_index: 2 }],
      }],
    }],
  }, 'query', validateWebSearchOptions({ max_results: 1 }));
  return { created_at: '2026-10-13T00:00:00Z', data: {
    search_query: 'query', answer: normalized.answer, results: normalized.results,
    search_timestamp: '2026-10-13T00:00:00Z',
    search_metadata: { sources: normalized.sources, citations: normalized.citations },
  } };
}

describe('search memory attribution', () => {
  it('keeps citation-only URLs outside max_results through consolidation', () => {
    const memory = memoryFixture();
    expect(memory.data.results).toHaveLength(1);
    const data = consolidateSearchMemories([memory]);
    expect(data.all_results).toHaveLength(1);
    expect(data.sources).toEqual(['https://example.invalid/first', 'https://example.invalid/cited']);
    expect(data.answer_attributions[0]).toMatchObject({ query: 'query', answer: memory.data.answer,
      citations: [{ title: 'Cited policy', url: 'https://example.invalid/cited', start_index: 1, end_index: 2 }],
    });
    expect(sharedConsolidation).toBe(consolidateSearchMemories);
  });

  it('includes resolvable sources and exact-answer citation offsets in the model context', () => {
    const memory = memoryFixture();
    const context = formatSearchMemoryAttribution(memory.data);
    expect(context).toContain('https://example.invalid/cited');
    expect(context).toContain('Cited policy');
    expect(context).toContain(`- Answer: ${memory.data.answer}`);
    expect(context).toContain('"start_index":1');
    expect(context.indexOf('https://example.invalid/cited')).toBeLessThan(context.indexOf('- Answer:'));
  });

  it('supports historical result-only memories and preserves their real scores', () => {
    const data = consolidateSearchMemories([{ data: { search_query: 'old query', answer: 'Old answer',
      results: [{ title: 'Historical', url: 'https://example.invalid/old', content: 'Historical content', score: 0.8 }],
    }, created_at: '2026-01-01T00:00:00Z' }]);
    expect(data.sources).toEqual(['https://example.invalid/old']);
    expect(data.answers).toEqual(['Old answer']);
    expect(data.consolidated_findings[0].score).toBe(0.8);
    expect(consolidateSearchMemories([memoryFixture()]).consolidated_findings[0]).not.toHaveProperty('score');
  });

  it('deduplicates sources and repeated annotations but keeps offsets scoped to each answer', () => {
    const first = memoryFixture();
    const citation = first.data.search_metadata.citations[0];
    const data = consolidateSearchMemories([first, { data: { ...first.data, search_query: 'second query',
      answer: 'Different answer.', citations: [citation], sources: ['https://example.invalid/cited'],
    } }]);
    expect(data.sources).toHaveLength(2);
    expect(data.answer_attributions).toHaveLength(2);
    expect(data.answer_attributions[1].citations).toHaveLength(1);
    expect(data.answer_attributions[1].answer).toBe('Different answer.');
  });

  it('handles empty and malformed optional metadata without inventing attribution', () => {
    expect(consolidateSearchMemories([])).toMatchObject({ total_searches: 0, sources: [], answers: [], answer_attributions: [] });
    expect(getSearchAnswerAttribution({ sources: {}, citations: 'malformed', search_metadata: null })).toMatchObject({ sources: [], citations: [] });
    expect(formatSearchMemoryAttribution({})).toBe('');
  });

  it('never propagates credentials inside source URLs into analysis data or context', () => {
    const url = new URL('https://example.invalid/private');
    url.username = randomBytes(12).toString('hex'); url.password = randomBytes(24).toString('hex');
    const memory = { data: { sources: [url.href, 'javascript:alert(1)'],
      search_metadata: { citations: [{ type: 'url_citation', url: url.href }], sources: [{ url: url.href }] },
    } };
    const output = JSON.stringify(consolidateSearchMemories([memory])) + formatSearchMemoryAttribution(memory.data);
    expect(output).not.toContain(url.username);
    expect(output).not.toContain(url.password);
    expect(output).not.toContain('javascript:');
  });
});

describe('both analysis entry points forward attribution to the actual model-command context', () => {
  const siteId = randomUUID(); const agentId = randomUUID(); const commandId = randomUUID(); const userId = randomUUID();
  beforeEach(() => {
    jest.mocked(CommandFactory.createCommand).mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline test must not make network calls'));
    jest.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
      const data = table === 'agents' ? { id: agentId, user_id: userId } : [memoryFixture()];
      const chain = { select: jest.fn(), eq: jest.fn(), order: jest.fn(), limit: jest.fn(),
        single: jest.fn(async () => ({ data, error: null })),
        then: (resolve: (result: { data: unknown; error: null }) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
      };
      for (const method of [chain.select, chain.eq, chain.order, chain.limit]) method.mockReturnValue(chain);
      return chain;
    }) as unknown as typeof supabaseAdmin.from);
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('the direct analysis service retains uncapped citations and exact answers', async () => {
    const result = await executeDataAnalysis(siteId, 'comprehensive', agentId, commandId, undefined, undefined, 50, true);
    expect(result.success).toBe(true);
    expect(CommandFactory.createCommand).toHaveBeenCalledWith(expect.objectContaining({ context: expect.stringContaining('https://example.invalid/cited') }));
    const context = jest.mocked(CommandFactory.createCommand).mock.calls[0][0].context;
    expect(context).toContain(`- Answer: ${memoryFixture().data.answer}`);
    expect(context).toContain('"start_index":1');
    expect(result.data.consolidated_data.answer_attributions[0].citations[0].url).toBe('https://example.invalid/cited');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the HTTP analysis route uses the same consolidation and exposes scoped citations', async () => {
    const response = await analysisPost(new Request('https://example.invalid/api/agents/dataAnalyst/analysis', {
      method: 'POST', body: JSON.stringify({ site_id: siteId, agent_id: agentId, command_id: commandId }),
    }));
    expect(response.status).toBe(200);
    expect(CommandFactory.createCommand).toHaveBeenCalledWith(expect.objectContaining({ context: expect.stringContaining('https://example.invalid/cited') }));
    const body = await response.json();
    expect(body.data.consolidated_search_data.sources).toContain('https://example.invalid/cited');
    expect(body.data.consolidated_search_data.answer_attributions[0].citations[0].title).toBe('Cited policy');
    expect(fetch).not.toHaveBeenCalled();
  });
});