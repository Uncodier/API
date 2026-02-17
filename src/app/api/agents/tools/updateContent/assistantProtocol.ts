/**
 * Assistant Protocol Wrapper for Update Content Tool
 * Update existing content items (title, status, text, etc.)
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface UpdateContentToolParams {
  content_id: string;
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  segment_id?: string;
  text?: string;
  tags?: string[];
  instructions?: string;
  campaign_id?: string;
  metadata?: Record<string, unknown>;
}

export function updateContentTool(site_id: string, _user_id?: string) {
  return {
    name: 'updateContent',
    description:
      'Update an existing content item. Required: content_id. Optional: title, description, type (blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page), status (draft, review, approved, published, archived), segment_id, text, tags, instructions, campaign_id, metadata.',
    parameters: {
      type: 'object',
      properties: {
        content_id: { type: 'string', description: 'Content UUID to update' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        type: {
          type: 'string',
          description:
            'Content type: blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page',
        },
        status: {
          type: 'string',
          description: 'draft, review, approved, published, archived',
        },
        segment_id: { type: 'string', description: 'Segment UUID' },
        text: { type: 'string', description: 'Body content / main text' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
        instructions: {
          type: 'string',
          description: 'Instructions for AI content generation or editing',
        },
        campaign_id: { type: 'string', description: 'Campaign UUID' },
        metadata: {
          type: 'object',
          description: 'Additional metadata',
        },
      },
      required: ['content_id'],
    },
    execute: async (args: UpdateContentToolParams) => {
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/updateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || 'Update content failed');
      }
      return data;
    },
  };
}
