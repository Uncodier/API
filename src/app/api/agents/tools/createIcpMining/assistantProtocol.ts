/**
 * Assistant Protocol Wrapper for Create ICP Mining Tool
 * Creates an ICP mining run in Finder (same as finder app createQuery)
 * Same format as analyzeICPTotalCount - flat finder payload or query object
 */

import { createIcpMiningCoreFromRoute } from './route';

export interface CreateIcpMiningToolParams {
  query?: Record<string, unknown>;
  person_industries?: number[];
  person_locations?: number[];
  person_skills?: number[];
  organization_domains?: string[];
  organization_industries?: number[];
  organization_locations?: number[];
  organization_keywords?: number[];
  organization_web_technologies?: number[];
  role_title?: string;
  role_description?: string;
  segment_id?: string;
  name?: string;
  total_targets?: number;
}

/**
 * Same finder field names as analyzeICPTotalCount
 */
export function createIcpMiningTool(site_id: string) {
  return {
    name: 'createIcpMining',
    description:
      'Create an ICP mining run in Finder. Pass filters using finder field names: person_industries, person_locations, person_skills (number[] IDs from getFinderCategoryIds), organization_domains (string[]), organization_industries, organization_locations (number[] IDs), role_title, role_description. Use getFinderCategoryIds first for industries/locations/skills. At least one filter required. Optional: name, segment_id, total_targets.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'object',
          description:
            'Filters object. Keys: person_industries, person_locations, person_skills (number[] IDs), organization_domains (string[]), organization_industries, organization_locations, role_title, role_description. At least one filter required.',
        },
        person_industries: { type: 'array', items: { type: 'number' }, description: 'Industry IDs from getFinderCategoryIds' },
        person_locations: { type: 'array', items: { type: 'number' }, description: 'Location IDs from getFinderCategoryIds' },
        person_skills: { type: 'array', items: { type: 'number' }, description: 'Skill IDs from getFinderCategoryIds' },
        organization_domains: { type: 'array', items: { type: 'string' }, description: 'Company domains e.g. ["example.com"]' },
        organization_industries: { type: 'array', items: { type: 'number' }, description: 'Organization industry IDs' },
        organization_locations: { type: 'array', items: { type: 'number' }, description: 'Organization location IDs' },
        organization_keywords: { type: 'array', items: { type: 'number' }, description: 'Organization keyword IDs' },
        organization_web_technologies: { type: 'array', items: { type: 'number' }, description: 'Web technology IDs' },
        role_title: { type: 'string', description: 'Job title filter' },
        role_description: { type: 'string', description: 'Role/job description filter' },
        name: { type: 'string', description: 'Optional name for the ICP mining run' },
        segment_id: { type: 'string', description: 'Optional segment UUID' },
        total_targets: { type: 'number', description: 'Optional estimated total targets count' },
      },
      required: [],
    },
    execute: async (args: CreateIcpMiningToolParams) => {
      // Pass full args: query and/or flat filters - route merges them like finder
      return createIcpMiningCoreFromRoute({
        ...args,
        site_id,
      } as Record<string, unknown>);
    },
  };
}
