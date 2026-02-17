/**
 * Assistant Protocol Wrapper for Web Search Tool
 * Formats the tool for OpenAI/assistant compatibility
 * Uses searchWithTavily from data-analyst-search (same as Data Analyst agent)
 */

import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';
import { searchWithTavily } from '@/lib/services/search/data-analyst-search';

export interface WebSearchToolParams {
  query: string;
}

function buildSearchResult(data: { answer?: string; results?: Array<{ content?: string; title?: string; url?: string }> }): string {
  if (data.answer && data.answer.trim()) {
    return data.answer;
  }
  const parts = (data.results || [])
    .map((r) => r.content || `${r.title || ''} ${r.url || ''}`.trim())
    .filter(Boolean);
  return parts.join('\n\n') || 'No results found.';
}

/**
 * Creates a web search tool for OpenAI/assistant compatibility
 * @returns Tool definition compatible with OpenAI function calling
 */
export function webSearchTool() {
  return {
    name: 'webSearch',
    description: 'Perform a web search to get real-time information.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to perform.',
        },
      },
      required: ['query'],
    },
    execute: async (args: WebSearchToolParams) => {
      try {
        console.log(`[WebSearchTool] 🌐 Executing web search for: ${args.query}`);

        const searchResult = await searchWithTavily(args.query, {
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        });

        if (!searchResult.success || !searchResult.data) {
          throw new Error(searchResult.error || 'Web search failed');
        }

        const result = buildSearchResult(searchResult.data);
        return {
          success: true,
          result,
          message: `Successfully performed web search for "${args.query}".`,
        };
      } catch (error: any) {
        console.error(`[WebSearchTool] ❌ Error during web search:`, error);
        throw error;
      }
    },
  };
}

/**
 * Creates a web search tool for Scrapybara SDK compatibility
 * Uses tool() helper from scrapybara/tools with Zod schemas
 * @param instance - The Scrapybara UbuntuInstance
 * @returns Tool definition compatible with Scrapybara SDK
 */
export function webSearchToolScrapybara(instance: UbuntuInstance) {
  return tool({
    name: 'webSearch',
    description: 'Perform a web search to get real-time information.',
    parameters: z.object({
      query: z.string().describe('The search query to perform.'),
    }),
    execute: async (args) => {
      try {
        console.log(`[WebSearchTool-Scrapybara] 🌐 Executing web search for: ${args.query}`);

        const searchResult = await searchWithTavily(args.query, {
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        });

        if (!searchResult.success || !searchResult.data) {
          throw new Error(searchResult.error || 'Web search failed');
        }

        const result = buildSearchResult(searchResult.data);
        return {
          success: true,
          result,
          message: `Successfully performed web search for "${args.query}".`,
        };
      } catch (error: any) {
        console.error(`[WebSearchTool-Scrapybara] ❌ Error during web search:`, error);
        throw error;
      }
    },
  });
}
