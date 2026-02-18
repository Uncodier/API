import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteCopywriting } from '@/lib/database/copywriting-db';

const DeleteCopywritingSchema = z.object({
  copywriting_id: z.string().uuid('Valid copywriting_id required'),
  site_id: z.string().uuid().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = DeleteCopywritingSchema.parse(body);

    await deleteCopywriting(validated.copywriting_id);

    return NextResponse.json(
      {
        success: true,
        message: 'Copywriting template deleted successfully',
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
