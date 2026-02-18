/**
 * Assistant Protocol Wrapper for Content Tool
 * Unified tool for managing content (create, list, update)
 */

import { getContentCore } from './get/route';

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface ContentToolParams {
  action: 'create' | 'list' | 'update';
  
  // Create/Update params
  content_id?: string; // Required for update/get single
  title?: string; // Required for create
  type?: string; // Required for create
  description?: string;
  status?: string;
  segment_id?: string;
  text?: string;
  tags?: string[];
  instructions?: string;
  campaign_id?: string;
  metadata?: Record<string, unknown>;

  // List params
  site_id?: string;
  user_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function contentTool(site_id: string, user_id?: string) {
  return {
    name: 'content',
    description:
      'Manage content. Use action="create" to create new content (requires title, type). Use action="update" to update existing content (requires content_id). Use action="list" to get content items with filters.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update'],
          description: 'Action to perform on content.'
        },
        // Common/Create/Update fields
        content_id: { type: 'string', description: 'Content UUID (required for update/get single)' },
        title: { type: 'string', description: 'Content title (required for create)' },
        type: { 
          type: 'string', 
          description: 'Content type: blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page (required for create)' 
        },
        description: { type: 'string', description: 'Short description or excerpt' },
        status: { 
          type: 'string', 
          description: 'Content status: draft, review, approved, published, archived' 
        },
        segment_id: { type: 'string', description: 'Segment UUID' },
        text: { type: 'string', description: 'Body content / main text' },
        tags: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'Tags for categorization' 
        },
        instructions: { type: 'string', description: 'Instructions for AI content generation or editing' },
        campaign_id: { type: 'string', description: 'Campaign UUID' },
        metadata: { type: 'object', description: 'Additional metadata (json object)' },
        
        // List specific filters
        site_id: { type: 'string', description: 'Filter by site UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        search: { type: 'string', description: 'Text search in title, description, text' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['action'],
    },
    execute: async (args: ContentToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        const body = {
          ...params,
          site_id,
          user_id,
        };
        // Check required fields for create
        if (!params.title || !params.type) {
           throw new Error('Missing required fields for create content: title, type');
        }

        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/content/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || data.error || 'Create content failed');
        }
        return data;
      }

      if (action === 'update') {
        if (!params.content_id) {
            throw new Error('Missing required field for update content: content_id');
        }
        const body = {
          ...params,
          site_id,
        };
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/content/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || data.error || 'Update content failed');
        }
        return data;
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || site_id,
          user_id: params.user_id || user_id,
        };
        return getContentCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
