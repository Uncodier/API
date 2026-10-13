import { z } from 'zod';

const sourceSchema = z.object({ url: z.string(), type: z.string().optional() });
const citationSchema = sourceSchema.extend({
  type: z.literal('url_citation'), title: z.string().optional(),
  start_index: z.number().int().nonnegative().optional(), end_index: z.number().int().nonnegative().optional(),
});
export type MemoryCitation = z.output<typeof citationSchema>;
export interface SearchAnswerAttribution {
  query: string;
  answer: string;
  citations: MemoryCitation[];
  sources: string[];
}

function safeSource(value: unknown): string | undefined {
  const input = typeof value === 'string' ? value : sourceSchema.safeParse(value).data?.url;
  if (!input) return undefined;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Accept old result-only memories and new Azure metadata without losing uncapped evidence. */
export function getSearchAnswerAttribution(raw: unknown): SearchAnswerAttribution {
  const data = record(raw);
  const metadata = record(data.search_metadata);
  const sources = new Set<string>();
  const citations: MemoryCitation[] = [];
  const seenCitations = new Set<string>();
  for (const entry of [...list(data.results), ...list(data.sources), ...list(metadata.sources)]) {
    const url = safeSource(entry);
    if (url) sources.add(url);
  }
  for (const entry of [...list(data.citations), ...list(metadata.citations)]) {
    const parsed = citationSchema.safeParse(entry);
    if (!parsed.success) continue;
    const url = safeSource(parsed.data.url);
    if (!url) continue;
    const citation = { ...parsed.data, url };
    const key = JSON.stringify(citation);
    if (!seenCitations.has(key)) { citations.push(citation); seenCitations.add(key); }
    sources.add(url);
  }
  return {
    query: typeof data.search_query === 'string' ? data.search_query : '',
    answer: typeof data.answer === 'string' ? data.answer : '',
    citations, sources: [...sources],
  };
}

/** Citation offsets refer to the exact answer in this block, not the surrounding prompt. */
export function formatSearchMemoryAttribution(data: unknown): string {
  const attribution = getSearchAnswerAttribution(data);
  const lines: string[] = [];
  if (attribution.sources.length) lines.push(`- Source URLs: ${JSON.stringify(attribution.sources)}`);
  if (attribution.citations.length) {
    lines.push('- Citation annotations (offsets apply only to the exact Answer below): '
      + JSON.stringify(attribution.citations));
  }
  if (attribution.answer) lines.push(`- Answer: ${attribution.answer}`);
  return lines.length ? `\n${lines.join('\n')}` : '';
}

/** Shared by both analysis entry points; keeps existing fields and scoped answer attribution. */
export function consolidateSearchMemories(memories: any[]): {
  total_searches: number; search_queries: string[]; all_results: any[];
  consolidated_findings: any[]; sources: string[]; answers: string[];
  answer_attributions: SearchAnswerAttribution[]; search_timeframe: { from: string; to: string };
} {
  const searchQueries = new Set<string>();
  const allResults: any[] = [];
  const consolidatedFindings: any[] = [];
  const sources = new Set<string>();
  const answers: string[] = [];
  const answerAttributions: SearchAnswerAttribution[] = [];
  let earliestSearch = new Date().toISOString();
  let latestSearch = new Date(0).toISOString();
  for (const memory of memories) {
    const data = memory.data || {};
    const attribution = getSearchAnswerAttribution(data);
    if (attribution.query) searchQueries.add(attribution.query);
    for (const source of attribution.sources) sources.add(source);
    if (attribution.answer) { answers.push(attribution.answer); answerAttributions.push(attribution); }
    for (const result of Array.isArray(data.results) ? data.results : []) {
      allResults.push(result);
      consolidatedFindings.push({
        query: data.search_query, title: result.title || '', content: result.content || '', url: result.url || '',
        // Azure does not return a relevance score; preserve historical scores, never fabricate one.
        ...(typeof result.score === 'number' ? { score: result.score } : {}),
        published_date: result.published_date || null, search_timestamp: data.search_timestamp,
      });
    }
    const searchTime = data.search_timestamp || memory.created_at;
    if (searchTime < earliestSearch) earliestSearch = searchTime;
    if (searchTime > latestSearch) latestSearch = searchTime;
  }
  return {
    total_searches: memories.length, search_queries: [...searchQueries], all_results: allResults,
    consolidated_findings: consolidatedFindings, sources: [...sources], answers,
    answer_attributions: answerAttributions, search_timeframe: { from: earliestSearch, to: latestSearch },
  };
}