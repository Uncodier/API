import { connectorHandler } from '@/lib/connectors/http';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return connectorHandler(request, 'detail', (await context.params).id);
}
