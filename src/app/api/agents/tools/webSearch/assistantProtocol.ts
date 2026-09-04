import { CreditService } from '@/lib/services/billing/CreditService';
/**
 * Assistant Protocol Wrapper for Web Search Tool
 * Formats the tool for OpenAI/assistant compatibility
 * Uses searchWithTavily from data-analyst-search (same as Data Analyst agent)
 */

import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';
import { searchWithTavily } from '@/lib/services/search/data-analyst-search';
import { formatWebSearchPayload } from './webSearch-format';

export interface WebSearchToolParams {
  query: string;
}

/**
 * Creates a web search tool for OpenAI/assistant compatibility
 * @returns Tool definition compatible with OpenAI function calling
 */
export function webSearchTool(site_id?: string) {
  return {
    name: 'webSearch',
    description: 'Search the live web. Returns titled results with https:// URLs — paste those URLs into research docs.',
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
        if (site_id) {
          const requiredCredits = CreditService.PRICING.TAVILY_SEARCH;
          const hasCredits = await CreditService.validateCredits(site_id, requiredCredits);
          if (!hasCredits) {
            throw new Error('Insufficient credits for web search');
          }
          await CreditService.deductCredits(site_id, requiredCredits, 'tavily_search', 'Web search via assistant', { query: args.query });
        }


        const searchResult = await searchWithTavily(args.query, {
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        });

        if (!searchResult.success || !searchResult.data) {
          throw new Error(searchResult.error || 'Web search failed');
        }

        const payload = formatWebSearchPayload(searchResult.data);
        return {
          success: true,
          result: payload.text,
          results: payload.results,
          answer: payload.answer,
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
export function webSearchToolScrapybara(instance: UbuntuInstance, site_id?: string) {
  return tool({
    name: 'webSearch',
    description: 'Search the live web. Returns titled results with https:// URLs — paste those URLs into research docs.',
    parameters: z.object({
      query: z.string().describe('The search query to perform.'),
    }),
    execute: async (args) => {
      try {
        console.log(`[WebSearchTool-Scrapybara] 🌐 Executing web search for: ${args.query}`);
        if (site_id) {
          const requiredCredits = CreditService.PRICING.TAVILY_SEARCH;
          const hasCredits = await CreditService.validateCredits(site_id, requiredCredits);
          if (!hasCredits) {
            throw new Error('Insufficient credits for web search');
          }
          await CreditService.deductCredits(site_id, requiredCredits, 'tavily_search', 'Web search via assistant', { query: args.query });
        }


        const searchResult = await searchWithTavily(args.query, {
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        });

        if (!searchResult.success || !searchResult.data) {
          throw new Error(searchResult.error || 'Web search failed');
        }

        const payload = formatWebSearchPayload(searchResult.data);
        return {
          success: true,
          result: payload.text,
          results: payload.results,
          answer: payload.answer,
          message: `Successfully performed web search for "${args.query}".`,
        };
      } catch (error: any) {
        console.error(`[WebSearchTool-Scrapybara] ❌ Error during web search:`, error);
        throw error;
      }
    },
  });
}
