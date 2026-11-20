import { publicCatalogResponse } from '@/lib/connectors/public-catalog';

export async function GET(request: Request) {
  return publicCatalogResponse(request, 'list');
}