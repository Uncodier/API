import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { AutomationSendSuppressed } from '@/lib/services/channels/automation-send-guard';
import { sendRoutedText } from '@/lib/services/whatsapp/routed-text';
import { readRoutedTextOutcome, stopRoutedTextPoll } from '@/lib/services/whatsapp/routed-text-recovery';

const identity = z.object({ site_id: z.string().uuid(), conversation_id: z.string().uuid(), message_id: z.string().uuid() }).strict();
const binding = identity.extend({ attempt_id: z.string().uuid(), connection_id: z.string().min(1).max(200),
  provider: z.enum(['zavu', 'twilio']), template_id: z.string().min(1).max(200) });
const headers = { 'Cache-Control': 'no-store, private' };

/** Neither recovery operation calls a provider. GET reads a receipt; PATCH can
 * stop only the exact idle poll returned by GET, under compare-and-set. */
export async function GET(request: Request) {
  if (!isInternalServiceRequest(request)) return NextResponse.json({ success: false }, { status: 403, headers });
  const input = identity.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!input.success) return NextResponse.json({ success: false }, { status: 400, headers });
  try { return NextResponse.json(await readRoutedTextOutcome(input.data), { headers }); }
  catch { return NextResponse.json({ success: false }, { status: 503, headers }); }
}

export async function PATCH(request: Request) {
  if (!isInternalServiceRequest(request)) return NextResponse.json({ success: false }, { status: 403, headers });
  const input = binding.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ success: false }, { status: 400, headers });
  const { site_id, conversation_id, message_id, ...expected } = input.data;
  try { return NextResponse.json(await stopRoutedTextPoll({ site_id, conversation_id, message_id }, expected), { headers }); }
  catch { return NextResponse.json({ success: false }, { status: 503, headers }); }
}

/** Internal worker only. Never accept a caller-supplied route, recipient or template SID. */
export async function POST(request: Request) {
  if (!isInternalServiceRequest(request)) return NextResponse.json({ success: false }, { status: 403 });
  const input = identity.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ success: false, error: 'Invalid WhatsApp message identity' }, { status: 400 });
  try {
    const result = await sendRoutedText(input.data);
    return NextResponse.json(result, { status: result.status === 'template_pending' ? 202 : 200 });
  } catch (err) {
    if (err instanceof AutomationSendSuppressed) return NextResponse.json({ success: true, status: 'skipped', skipped: true,
      message_id: input.data.message_id, reason: err.reason });
    // No durable outcome was obtained. Distinguish this from a persisted unknown
    // result: the worker must read the receipt, never blindly retry this POST.
    return NextResponse.json({ success: false, status: 'needs_reconciliation', message_id: input.data.message_id,
      reason: 'The saved WhatsApp route or receipt could not be verified.' }, { status: 503, headers });
  }
}