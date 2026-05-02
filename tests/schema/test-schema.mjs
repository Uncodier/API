import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const supabaseUrl = 'https://db.makinari.com';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  console.log('Testing requirements table schema...');
  const { data, error } = await supabase
    .from('requirements')
    .select('id, cron_lock_expires_at, cron_lock_run_id')
    .limit(1);
    
  if (error) {
    console.error('Error:', error);
  } else {
    console.log('Success! Columns exist. Data:', data);
  }
}

test();
