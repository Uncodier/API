import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const supabaseUrl = 'https://db.makinari.com';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey, {
  global: {
    fetch: (...args) => {
      console.log('Fetching:', args[0]);
      return fetch(...args);
    }
  }
});

async function test() {
  const requirementId = '32924643-dd88-4f1a-95ee-05ab4c7167dc';
  const nowIso = new Date().toISOString();
  const orClause = `cron_lock_expires_at.is.null,cron_lock_expires_at.lt."${nowIso.replace(/"/g, '""')}"`;
  
  const { data, error } = await supabase
    .from('requirements')
    .select('id')
    .eq('id', requirementId)
    .or(orClause);
    
  if (error) {
    console.log('Error code:', error.code);
    console.log('Error message:', error.message);
  } else {
    console.log('Success!', data);
  }
}

test();
