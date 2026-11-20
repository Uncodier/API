import { connectorHandler } from '@/lib/connectors/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return connectorHandler(request, 'access', (await context.params).id);
}
export async function PATCH(request: Request, context: Context) {
  return connectorHandler(request, 'update-access', (await context.params).id);
}