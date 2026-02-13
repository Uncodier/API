import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('Missing environment variables');
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

async function checkRequirementTypes() {
  console.log('Checking requirement_type enum values...');
  
  try {
    const { data, error } = await supabaseAdmin
      .from('requirements')
      .select('type')
      .limit(10);
      
    if (error) {
      console.log('Error querying:', error.message);
    } else {
      const types = new Set(data.map(r => r.type));
      console.log('Found types in database:', Array.from(types));
    }
    
    // Also try to insert invalid type to see enum constraints
    const { error: insertError } = await supabaseAdmin
      .from('requirements')
      .select('*')
      .eq('type', 'INVALID_TYPE_TO_TRIGGER_ERROR');
      
    if (insertError) {
      console.log('Error querying with invalid type:', insertError.message);
    }
    
  } catch (e) {
    console.log('Exception:', e);
  }
}

checkRequirementTypes();
