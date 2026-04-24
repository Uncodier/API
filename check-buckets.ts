import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const repoUrl = process.env.REPOSITORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const repoKey = process.env.REPOSITORY_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const supabase = createClient(repoUrl!, repoKey!);

  const { data, error } = await supabase.storage.listBuckets();
  console.log('Buckets in REPOSITORY_SUPABASE_URL:', data?.map(b => b.name), error);

  const nextUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const nextKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabase2 = createClient(nextUrl!, nextKey!);
  const { data: data2, error: error2 } = await supabase2.storage.listBuckets();
  console.log('Buckets in NEXT_PUBLIC_SUPABASE_URL:', data2?.map(b => b.name), error2);
}

main();