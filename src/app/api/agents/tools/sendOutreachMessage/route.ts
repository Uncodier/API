import { NextResponse } from 'next/server';
import { z } from 'zod';
import { canAccessSite } from '@/lib/security/site-access';
import { createOutreachDelivery } from '@/lib/services/outreach/delivery';

export const runtime = 'nodejs';
const bodySchema = z.object({ site_id: z.string().uuid(), message_id: z.string().uuid() }).strict();
const deliver = createOutreachDelivery();

/** Authenticated by the API tool middleware; tenant access is checked here too. */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, reason: 'invalid_request' }, { status: 400 });
  const { site_id, message_id } = parsed.data;
  if (!await canAccessSite(request, site_id)) return NextResponse.json({ success: false, reason: 'site_access_denied' }, { status: 403 });
  const result = await deliver(site_id, message_id);
  return NextResponse.json(result, { status: result.reason === 'message_not_found' ? 404 : 200 });
}