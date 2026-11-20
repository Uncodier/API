import { connectorHandler } from '@/lib/connectors/http';

export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return connectorHandler(request, 'connection-summary', (await context.params).id);
}
