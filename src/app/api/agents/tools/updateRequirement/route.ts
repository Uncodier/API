import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateRequirement, getRequirementById } from '@/lib/database/requirement-db';

const UpdateRequirementSchema = z.object({
  requirement_id: z.string().uuid('Requirement ID must be a valid UUID'),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  status: z.enum(['backlog', 'validated', 'in-progress', 'on-review', 'done', 'canceled']).optional(),
  completion_status: z.enum(['pending', 'completed', 'rejected']).optional(),
  type: z.string().optional(),
  budget: z.number().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = UpdateRequirementSchema.parse(body);

    const { requirement_id, ...updateFields } = validated;

    const existing = await getRequirementById(requirement_id);
    if (!existing) {
      return NextResponse.json({
        success: false,
        error: 'Requirement not found',
      }, { status: 404 });
    }

    const requirement = await updateRequirement(requirement_id, updateFields);

    return NextResponse.json({
      success: true,
      requirement,
    }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }
    if (error instanceof Error) {
      return NextResponse.json({
        success: false,
        error: error.message,
      }, { status: 500 });
    }
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
    }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  return POST(request);
}
