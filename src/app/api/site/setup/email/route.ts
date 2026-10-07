import { NextResponse } from 'next/server';
import { extractApiKeyCredential, isServiceApiKeyCredential } from '@/lib/security/api-key-credential';
import { dispatchSetupEmail, unconfirmedSetupEmail } from './setup-email-dispatch';
import { readSetupEmailRequest, SetupEmailInputError } from './setup-email-request';

export const runtime = 'nodejs';
export const maxDuration = 90;
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store' },
});

export async function POST(request: Request) {
  // Own route authorization: browser keys/session/middleware identity are not proof.
  let authorized = false;
  try { authorized = await isServiceApiKeyCredential(extractApiKeyCredential(request)); }
  catch { return json({ success: false, error: 'Internal authentication unavailable' }, 503); }
  if (!authorized) {
    return json({ success: false, error: 'Internal service authentication required' }, 401);
  }
  let input;
  try { input = await readSetupEmailRequest(request); }
  catch (error) { return json({ success: false, error: 'Invalid setup email request' }, error instanceof SetupEmailInputError ? error.status : 400); }
  try {
    // The atomic RPC validates persisted active-site identity; no caller actor/tenant.
    const result = await dispatchSetupEmail(input);
    return json(result.body, result.httpStatus);
  } catch {
    return json(unconfirmedSetupEmail('receipt_storage_unavailable'), 503);
  }
}