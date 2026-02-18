import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateLead, getLeadById } from '@/lib/database/lead-db';

const UpdateLeadSchema = z.object({
  lead_id: z.string().uuid('Lead ID must be a valid UUID'),
  site_id: z.string().uuid('Site ID is required'),
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  position: z.string().optional(),
  company: z.union([z.record(z.any()), z.string()]).optional(),
  notes: z.string().optional(),
  status: z.enum(['new', 'contacted', 'qualified', 'converted', 'lost']).optional(),
  origin: z.string().optional(),
  segment_id: z.string().uuid().optional().nullable(),
  campaign_id: z.string().uuid().optional().nullable(),
  assignee_id: z.string().uuid().optional().nullable(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = UpdateLeadSchema.parse(body);

    const { lead_id, site_id, ...updateFields } = validated;

    const existing = await getLeadById(lead_id);
    if (!existing) {
      return NextResponse.json({
        success: false,
        error: 'Lead not found',
      }, { status: 404 });
    }

    if (existing.site_id !== site_id) {
      return NextResponse.json({
        success: false,
        error: 'No tienes permiso para actualizar este lead',
      }, { status: 403 });
    }

    const lead = await updateLead(lead_id, updateFields);

    return NextResponse.json({
      success: true,
      lead,
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
