import { handleOpenRouter } from '@/lib/integrations/openrouter/http';
export const runtime = 'nodejs';
export async function GET(request: Request) { return handleOpenRouter(request, 'setup'); }