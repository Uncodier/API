import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateRequirement, getRequirementById } from '@/lib/database/requirement-db';

const UpdateRequirementSchema = z.object({
  requirement_id: z.string().uuid('Requirement ID must be a valid UUID'),
  site_id: z.string().uuid('Site ID is required'),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  status: z.enum(['backlog', 'validated', 'in-progress', 'on-review', 'done', 'canceled']).optional(),
  completion_status: z.enum(['pending', 'completed', 'rejected']).optional(),
  type: z.string().optional(),
  budget: z.number().optional(),
});

/**
 * Core function to update a requirement
 */
export async function updateRequirementCore(params: any) {
  const validated = UpdateRequirementSchema.parse(params);

  const { requirement_id, site_id, ...updateFields } = validated;

  const existing = await getRequirementById(requirement_id);
  if (!existing) {
    throw new Error('Requirement not found');
  }

  if (existing.site_id !== site_id) {
    throw new Error('No tienes permiso para actualizar este requerimiento');
  }

  const requirement = await updateRequirement(requirement_id, updateFields);

  return {
    success: true,
    requirement,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await updateRequirementCore(body);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const status = errorMessage === 'Requirement not found' ? 404 : (errorMessage === 'No tienes permiso para actualizar este requerimiento' ? 403 : 500);
    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: status });
  }
}

export async function PUT(request: NextRequest) {
  return POST(request);
}
