import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLeads, getLeadById } from '@/lib/database/lead-db';

const GetLeadsSchema = z.object({
  lead_id: z.string().uuid().optional(),
  site_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  status: z.string().optional(),
  segment_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  assignee_id: z.string().uuid().optional(),
  search: z.string().optional(),
  sort_by: z.enum(['created_at', 'updated_at', 'name', 'status', 'last_contact']).optional().default('created_at'),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
  limit: z.number().int().min(1).max(500).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Core logic for getLead - callable from route or assistant protocol
 */
export async function getLeadCore(filters: Record<string, unknown>) {
  const validated = GetLeadsSchema.parse(filters);

  if (validated.lead_id) {
    const lead = await getLeadById(validated.lead_id);
    return {
      success: true,
      data: {
        lead: lead ?? null,
        pagination: null,
      },
    };
  }

  const filterObj = {
    site_id: validated.site_id,
    user_id: validated.user_id,
    status: validated.status,
    segment_id: validated.segment_id,
    campaign_id: validated.campaign_id,
    assignee_id: validated.assignee_id,
    search: validated.search,
    sort_by: validated.sort_by,
    sort_order: validated.sort_order,
    limit: validated.limit,
    offset: validated.offset,
  };

  const { leads, total, hasMore } = await getLeads(filterObj);

  return {
    success: true,
    data: {
      leads,
      pagination: {
        total,
        count: leads.length,
        offset: validated.offset,
        limit: validated.limit,
        has_more: hasMore,
      },
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getLeadCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid filters',
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
