import { handleOpenRouter } from '@/lib/integrations/openrouter/http';
export const runtime = 'nodejs';
export const maxDuration = 240;
export async function GET(request: Request) { return handleOpenRouter(request, 'read'); }
export async function POST(request: Request) { return handleOpenRouter(request, 'mutate'); }
