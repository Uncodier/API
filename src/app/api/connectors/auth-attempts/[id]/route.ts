import { connectorAuthHandler } from '@/lib/connectors/auth-http';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return connectorAuthHandler(request, 'get', (await context.params).id);
}