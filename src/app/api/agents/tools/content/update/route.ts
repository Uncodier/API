import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateContent, getContentById } from '@/lib/database/content-db';

const CONTENT_TYPES_ZOD = [
  'blog_post', 'video', 'podcast', 'social_post', 'newsletter',
  'case_study', 'whitepaper', 'infographic', 'webinar', 'ebook', 'ad', 'landing_page',
] as const;

const CONTENT_STATUSES_ZOD = ['draft', 'review', 'approved', 'published', 'archived'] as const;

const UpdateContentSchema = z.object({
  content_id: z.string().uuid('Content ID must be a valid UUID'),
  site_id: z.string().uuid('Site ID is required'),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(CONTENT_TYPES_ZOD).optional(),
  status: z.enum(CONTENT_STATUSES_ZOD).optional(),
  segment_id: z.string().uuid().optional().nullable(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  campaign_id: z.string().uuid().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
  published_at: z.string().datetime().optional().nullable(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = UpdateContentSchema.parse(body);

    const { content_id, site_id, ...updateFields } = validated;

    const existing = await getContentById(content_id);
    if (!existing) {
      return NextResponse.json(
        {
          success: false,
          error: 'Content not found',
        },
        { status: 404 }
      );
    }

    if (existing.site_id !== site_id) {
      return NextResponse.json(
        {
          success: false,
          error: 'No tienes permiso para actualizar este contenido',
        },
        { status: 403 }
      );
    }

    const content = await updateContent(content_id, updateFields);

    return NextResponse.json(
      {
        success: true,
        content,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid input',
          details: error.errors,
        },
        { status: 400 }
      );
    }
    if (error instanceof Error) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 500 }
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  return POST(request);
}
