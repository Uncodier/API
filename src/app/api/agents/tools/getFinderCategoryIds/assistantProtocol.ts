/**
 * Assistant Protocol Wrapper for Get Finder Category IDs Tool
 * Lookup IDs for industries, locations, etc. via Forager autocomplete.
 * MUST be used BEFORE analyzeICPTotalCount and createIcpMining - those tools require IDs, not free text.
 */

import { getFinderCategoryIdsCore } from './route';

const CATEGORIES = [
  'industries',
  'organizations',
  'organization_keywords',
  'locations',
  'person_skills',
  'web_technologies',
] as const;

export interface GetFinderCategoryIdsToolParams {
  category: (typeof CATEGORIES)[number];
  q: string;
  page?: number;
}

export function getFinderCategoryIdsTool(_site_id: string) {
  return {
    name: 'getFinderCategoryIds',
    description:
      'Get category IDs from Finder autocomplete. Categories: industries, organizations, organization_keywords, locations, person_skills, web_technologies. Returns results with id and text. IMPORTANT: Use this tool BEFORE analyzeICPTotalCount or createIcpMining when the user mentions industries, locations, job skills, etc. - those tools require IDs, not free text. Search with q to find the correct ID.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: CATEGORIES,
          description:
            'Category to search: industries, organizations, organization_keywords, locations, person_skills, web_technologies',
        },
        q: {
          type: 'string',
          description:
            'Search term (e.g. "technology", "New York", "Marketing Manager") to find matching IDs',
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default 1)',
        },
      },
      required: ['category', 'q'],
    },
    execute: async (args: GetFinderCategoryIdsToolParams) => {
      return getFinderCategoryIdsCore({
        category: args.category,
        q: args.q,
        page: args.page,
      });
    },
  };
}
