import { openPrivateReport } from '@/lib/connectors/private-report-choice';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return openPrivateReport(request, (await params).id);
}
