import { connectorHandler } from '@/lib/connectors/http';

export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return connectorHandler(request, 'disconnect', (await context.params).id);
}