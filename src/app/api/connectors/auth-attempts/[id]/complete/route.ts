import { connectorAuthHandler } from '@/lib/connectors/auth-http';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return connectorAuthHandler(request, 'complete', (await context.params).id);
}