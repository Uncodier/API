import { connectorHandler } from '@/lib/connectors/http';

/** Legacy catalogue path shares verified-user authorization and safe DTOs. */
export async function GET(request: Request) {
  return connectorHandler(request, 'catalog');
}
