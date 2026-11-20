import { approvalHandler } from '@/lib/connectors/approval-http';

export async function POST(request: Request, context: { params: Promise<{ id: string; decision: string }> }) {
  return approvalHandler(request, await context.params);
}
