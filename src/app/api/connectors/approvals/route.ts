import { approvalHandler } from '@/lib/connectors/approval-http';

export async function GET(request: Request) {
  return approvalHandler(request);
}
