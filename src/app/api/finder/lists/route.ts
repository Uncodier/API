import { persistSelectedList } from '@/lib/services/finder/selected-lists';

export async function POST(request: Request) {
  return persistSelectedList(request);
}