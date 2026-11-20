import { publicCatalogResponse } from '@/lib/connectors/public-catalog';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return publicCatalogResponse(request, 'tools', (await params).slug);
}