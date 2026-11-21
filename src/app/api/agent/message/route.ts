import { receiveZavuWebhook } from '@/lib/services/zavu/receive-webhook';

// Admission only. A provider signature on the original bytes, not a caller's
// site_id, agentId or middleware identity, authorizes this adapter.
export async function POST(request: Request) {
  return receiveZavuWebhook(request);
}