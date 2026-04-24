import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  // Let's check if there are ANY visual probe logs with errors logged by our new console.warns
  // or if there are ANY instance logs with 'VisualProbe' in the message
  const { data, error } = await supabase
    .from('instance_logs')
    .select('created_at, level, message, details')
    .ilike('message', '%VisualProbe%')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Error fetching logs:', error);
    return;
  }

  console.log(`Found ${data.length} logs containing 'VisualProbe' in message`);
  if (data.length > 0) {
    console.log(JSON.stringify(data, null, 2));
  }
}

main();