/**
 * Assistant Protocol Wrapper for Get Content Tool
 * Retrieve content with filters for content management
 */

import { getContentCore } from './route';

export interface GetContentToolParams {
  content_id?: string;
  site_id?: string;
  user_id?: string;
  type?: string;
  status?: string;
  campaign_id?: string;
  segment_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function getContentTool(site_id: string, user_id?: string) {
  return {
    name: 'getContent',
    description:
      'Get content items with optional filters. Pass content_id to get a single content by ID. Or use filters: site_id, user_id, type (blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page), status (draft, review, approved, published, archived), campaign_id, segment_id, search (title/description/text), limit (default 50). Returns contents and pagination.',
    parameters: {
      type: 'object',
      properties: {
        content_id: { type: 'string', description: 'Get single content by UUID' },
        site_id: { type: 'string', description: 'Filter by site UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        type: {
          type: 'string',
          description:
            'Content type: blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page',
        },
        status: {
          type: 'string',
          description: 'Content status: draft, review, approved, published, archived',
        },
        campaign_id: { type: 'string', description: 'Filter by campaign UUID' },
        segment_id: { type: 'string', description: 'Filter by segment UUID' },
        search: { type: 'string', description: 'Text search in title, description, text' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: [],
    },
    execute: async (args: GetContentToolParams) => {
      const filters = {
        ...args,
        site_id: args.site_id || site_id,
        user_id: args.user_id || user_id,
      };
      return getContentCore(filters);
    },
  };
}
