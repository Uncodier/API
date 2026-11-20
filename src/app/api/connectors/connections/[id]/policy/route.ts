import { connectorHandler } from '@/lib/connectors/http';

export const runtime = 'nodejs';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return connectorHandler(request, 'policy', (await context.params).id);
}