/**
 * Assistant Protocol Wrapper for Create Content Tool
 * Creates content items for content marketing workflows
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface CreateContentToolParams {
  title: string;
  type: string;
  description?: string;
  status?: string;
  segment_id?: string;
  text?: string;
  tags?: string[];
  instructions?: string;
  campaign_id?: string;
  metadata?: Record<string, unknown>;
}

export function createContentTool(site_id: string, user_id?: string) {
  return {
    name: 'createContent',
    description:
      'Create a new content item. Required: title, type (blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page). Optional: description, status (draft, review, approved, published, archived), segment_id, text (body content), tags, instructions (AI writing instructions), campaign_id, metadata.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Content title' },
        type: {
          type: 'string',
          description:
            'Content type: blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page',
        },
        description: { type: 'string', description: 'Short description or excerpt' },
        status: {
          type: 'string',
          description: 'draft, review, approved, published, archived (default: draft)',
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
          description: 'Additional metadata (json object)',
        },
      },
      required: ['title', 'type'],
    },
    execute: async (args: CreateContentToolParams) => {
      const body = {
        ...args,
        site_id,
        user_id,
      };
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/createContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || 'Create content failed');
      }
      return data;
    },
  };
}
