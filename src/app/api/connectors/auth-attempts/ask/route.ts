import { connectorAuthHandler } from '@/lib/connectors/auth-http';

// Dedicated entry for the Connect screen that discloses default Ask access.
// Older clients and callbacks cannot opt in an existing or in-flight connection.
export function POST(request:Request) { return connectorAuthHandler(request,'start-ask'); }