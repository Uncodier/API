import { CreditService } from '@/lib/services/billing/CreditService';
/**
 * Assistant Protocol Wrapper for Web Search Tool
 * Formats the tool for OpenAI/assistant compatibility
 * Uses the shared Azure Bing search adapter (same as Data Analyst agent)
 */

import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';
import { getWebSearchConfig, searchWeb } from '@/lib/services/search/web-search';
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
    description: 'Search the public web using Bing-indexed sources. Returns results: [{title,url,snippet}]. If you will write a research doc, paste the url fields next to every name.',
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
        args = z.object({ query: z.string().trim().min(1).max(8000) }).parse(args);
        console.log(`[WebSearchTool] 🌐 Executing web search for: ${args.query}`);
        if (site_id) {
          getWebSearchConfig(); // Admission failure must not charge internal credits.
          const requiredCredits = CreditService.PRICING.WEB_SEARCH;
          const hasCredits = await CreditService.validateCredits(site_id, requiredCredits);
          if (!hasCredits) {
            throw new Error('Insufficient credits for web search');
          }
          const deduction = await CreditService.deductCredits(site_id, requiredCredits, 'web_search', 'Web search via assistant', { query: args.query, provider: 'azure_bing' });
          if (!deduction.success) throw new Error(deduction.error || 'Credit deduction failed');
        }


        const searchResult = await searchWeb(args.query, {
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        });

        if (!searchResult.success) {
          throw new Error(searchResult.error || 'Web search failed');
        }

        const payload = formatWebSearchPayload(searchResult.data);
        return {
          success: true,
          result: payload.text,
          results: payload.results,
          answer: searchResult.data.answer,
          citations: searchResult.data.citations,
          sources: searchResult.data.sources,
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
    description: 'Search the public web using Bing-indexed sources. Returns results: [{title,url,snippet}]. If you will write a research doc, paste the url fields next to every name.',
    parameters: z.object({
      query: z.string().describe('The search query to perform.'),
    }),
    execute: async (args) => {
      try {
        args = z.object({ query: z.string().trim().min(1).max(8000) }).parse(args);
        console.log(`[WebSearchTool-Scrapybara] 🌐 Executing web search for: ${args.query}`);
        if (site_id) {
          getWebSearchConfig();
          const requiredCredits = CreditService.PRICING.WEB_SEARCH;
          const hasCredits = await CreditService.validateCredits(site_id, requiredCredits);
          if (!hasCredits) {
            throw new Error('Insufficient credits for web search');
          }
          const deduction = await CreditService.deductCredits(site_id, requiredCredits, 'web_search', 'Web search via assistant', { query: args.query, provider: 'azure_bing' });
          if (!deduction.success) throw new Error(deduction.error || 'Credit deduction failed');
        }


        const searchResult = await searchWeb(args.query, {
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        });

        if (!searchResult.success) {
          throw new Error(searchResult.error || 'Web search failed');
        }

        const payload = formatWebSearchPayload(searchResult.data);
        return {
          success: true,
          result: payload.text,
          results: payload.results,
          answer: searchResult.data.answer,
          citations: searchResult.data.citations,
          sources: searchResult.data.sources,
          message: `Successfully performed web search for "${args.query}".`,
        };
      } catch (error: any) {
        console.error(`[WebSearchTool-Scrapybara] ❌ Error during web search:`, error);
        throw error;
      }
    },
  });
}
