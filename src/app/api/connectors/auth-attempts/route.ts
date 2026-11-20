import { connectorAuthHandler } from '@/lib/connectors/auth-http';

export function POST(request: Request) { return connectorAuthHandler(request, 'start'); }