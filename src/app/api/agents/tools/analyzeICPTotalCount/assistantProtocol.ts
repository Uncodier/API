/**
 * Assistant Protocol Wrapper for Analyze ICP Total Count Tool
 * Returns the total count of targets from Finder (Forager person_role_search totals)
 */

import { analyzeICPTotalCountCore } from './route';

export interface AnalyzeICPTotalCountToolParams {
  query?: Record<string, unknown>;
  site_id?: string;
}

/**
 * Finder/Forager person_role_search field names (same as finder app):
 * person_industries, person_locations, person_skills (number[] - IDs from getFinderCategoryIds),
 * organization_domains (string[]), organizations, organization_keywords, organization_industries,
 * organization_locations, organization_web_technologies (number[] - IDs),
 * role_title, role_description (string).
 */
export function analyzeICPTotalCountTool(site_id: string) {
  return {
    name: 'analyzeICPTotalCount',
    description:
      'Analyze the total count of ICP targets from Finder. Pass filters using finder field names: person_industries, person_locations, person_skills (number[] IDs from getFinderCategoryIds), organization_domains (string[]), organization_industries, organization_locations (number[] IDs), role_title, role_description. Use getFinderCategoryIds first for industries/locations/skills—they require IDs. Can pass filters in query object or at top level.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'object',
          description:
            'Filters object. Keys: person_industries, person_locations, person_skills (number[] IDs), organization_domains (string[]), organization_industries, organization_locations, organization_keywords, organization_web_technologies (number[] IDs), role_title, role_description. Can be empty {} for total count.',
        },
        person_industries: { type: 'array', items: { type: 'number' }, description: 'Industry IDs from getFinderCategoryIds(category: "industries", q: "...")' },
        person_locations: { type: 'array', items: { type: 'number' }, description: 'Location IDs from getFinderCategoryIds(category: "locations", q: "...")' },
        person_skills: { type: 'array', items: { type: 'number' }, description: 'Skill IDs from getFinderCategoryIds(category: "person_skills", q: "...")' },
        organization_domains: { type: 'array', items: { type: 'string' }, description: 'Company domains e.g. ["example.com"]' },
        organization_industries: { type: 'array', items: { type: 'number' }, description: 'Organization industry IDs' },
        organization_locations: { type: 'array', items: { type: 'number' }, description: 'Organization location IDs' },
        organization_keywords: { type: 'array', items: { type: 'number' }, description: 'Organization keyword IDs' },
        organization_web_technologies: { type: 'array', items: { type: 'number' }, description: 'Web technology IDs' },
        role_title: { type: 'string', description: 'Job title filter' },
        role_description: { type: 'string', description: 'Role/job description filter' },
        site_id: { type: 'string', description: 'Optional site UUID for context' },
      },
      required: [],
    },
    execute: async (args: AnalyzeICPTotalCountToolParams) => {
      // Pass full args: query (nested) and/or flat filters (person_industries, organization_domains, etc.)
      // Same format as finder - core merges both into Forager payload
      return analyzeICPTotalCountCore({
        ...args,
        site_id: args.site_id || site_id,
      } as Record<string, unknown>);
    },
  };
}
