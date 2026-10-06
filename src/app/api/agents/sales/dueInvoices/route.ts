import { NextResponse } from 'next/server';
import { z } from 'zod';
import { canAccessSite } from '@/lib/security/site-access';
import { createInvoiceReminders } from '@/lib/services/outreach/invoices';

export const runtime = 'nodejs';
export const maxDuration = 300;
const schema = z.object({ site_id: z.string().uuid(), sale_id: z.string().uuid(),
  outreach_activity: z.literal('invoices_due'), reminder_key: z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/) }).strict();
const remind = createInvoiceReminders();

/** Private API middleware authenticates write scope; tenant authorization is explicit. */
export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, reason: 'invalid_request' }, { status: 400 });
  const { site_id, sale_id, reminder_key } = parsed.data;
  if (!await canAccessSite(request, site_id)) return NextResponse.json({ success: false, reason: 'site_access_denied' }, { status: 403 });
  const data = await remind(site_id, sale_id, reminder_key);
  return NextResponse.json({ success: true, data }, { status: data.reason === 'sale_not_found' ? 404 : 200 });
}