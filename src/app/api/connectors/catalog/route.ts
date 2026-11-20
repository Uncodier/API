import { connectorHandler } from '@/lib/connectors/http';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  return connectorHandler(request, 'catalog');
}