import { persistSelectedList } from '@/lib/services/finder/selected-lists';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return persistSelectedList(request, id);
}