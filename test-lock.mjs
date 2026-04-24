import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const supabaseUrl = 'https://db.makinari.com';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const requirementId = '32924643-dd88-4f1a-95ee-05ab4c7167dc'; // from previous test
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10000).toISOString();
  const runId = 'test-run-id';
  
  // Test with double quotes (what was there before)
  const orClauseDouble = `cron_lock_expires_at.is.null,cron_lock_expires_at.lt."${nowIso}"`;
  
  console.log('Testing with double quotes (what was failing):');
  const { data: data1, error: err1 } = await supabase
    .from('requirements')
    .select('id')
    .eq('id', requirementId)
    .or(orClauseDouble);
    
  if (err1) {
    console.log('Error code:', err1.code);
    console.log('Error message:', err1.message);
  } else {
    console.log('Success!', data1);
  }
  
  // Test with NO quotes
  const orClauseNone = `cron_lock_expires_at.is.null,cron_lock_expires_at.lt.${nowIso}`;
  
  console.log('\nTesting with NO quotes:');
  const { data: data2, error: err2 } = await supabase
    .from('requirements')
    .select('id')
    .eq('id', requirementId)
    .or(orClauseNone);
    
  if (err2) {
    console.log('Error code:', err2.code);
    console.log('Error message:', err2.message);
  } else {
    console.log('Success!', data2);
  }
}

test();
