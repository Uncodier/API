import { getCopywritings, CopywritingFilters } from '@/lib/database/copywriting-db';

export async function getCopywritingsCore(filters: CopywritingFilters) {
  return getCopywritings(filters);
}

