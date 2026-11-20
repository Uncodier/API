import { connectorHandler } from '@/lib/connectors/http';

export function POST(request: Request) {
  return connectorHandler(request, 'supabase-token');
}