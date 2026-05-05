import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createContent } from '@/lib/database/content-db';

const CONTENT_TYPES_ZOD = [
  'blog_post', 'video', 'podcast', 'social_post', 'newsletter',
  'case_study', 'whitepaper', 'infographic', 'webinar', 'ebook', 'ad', 'landing_page',
] as const;

const CONTENT_STATUSES_ZOD = ['draft', 'review', 'approved', 'published', 'archived'] as const;

const CreateContentSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  type: z.enum(CONTENT_TYPES_ZOD),
  site_id: z.string().uuid('Valid site_id required'),
  user_id: z.string().uuid().optional(),
  description: z.string().optional(),
  status: z.enum(CONTENT_STATUSES_ZOD).optional().default('draft'),
  segment_id: z.string().uuid().optional(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  campaign_id: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

async function resolveUserId(siteId: string, userId?: string): Promise<string | undefined> {
  if (userId) return userId;
  const { data } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', siteId)
    .single();
  return data?.user_id;
}

export async function createContentCore(input: any) {
  const validated = CreateContentSchema.parse(input);
  const effectiveUserId = await resolveUserId(validated.site_id, validated.user_id);

  const content = await createContent({
    title: validated.title,
    type: validated.type,
    site_id: validated.site_id,
    user_id: effectiveUserId,
    description: validated.description,
    status: validated.status,
    segment_id: validated.segment_id,
    text: validated.text,
    tags: validated.tags,
    instructions: validated.instructions,
    campaign_id: validated.campaign_id,
    metadata: validated.metadata,
  });

  return content;
}