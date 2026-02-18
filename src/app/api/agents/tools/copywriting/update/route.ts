import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateCopywriting, COPY_TYPES, COPY_STATUSES } from '@/lib/database/copywriting-db';

const UpdateCopywritingSchema = z.object({
  copywriting_id: z.string().uuid('Valid copywriting_id required'),
  site_id: z.string().uuid().optional(), // Used for permission checks in some cases, though not used here yet
  title: z.string().optional(),
  copy_type: z.enum(COPY_TYPES).optional(),
  content: z.string().optional(),
  status: z.enum(COPY_STATUSES).optional(),
  target_audience: z.string().optional(),
  use_case: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = UpdateCopywritingSchema.parse(body);
    const { copywriting_id, ...params } = validated;

    const copywriting = await updateCopywriting(copywriting_id, params);

    return NextResponse.json(
      {
        success: true,
        copywriting,
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
