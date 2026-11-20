import { connectorHandler } from '@/lib/connectors/http';

export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  return connectorHandler(request, 'detail', (await context.params).slug);
}