#!/usr/bin/env node

/**
 * This script tests the connection to the Supabase database
 * and verifies if the site_analysis table exists.
 * 
 * Usage:
 * node src/scripts/test_site_analysis_table.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Get Supabase connection details from environment variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('ERROR: Missing Supabase credentials in environment variables.');
  console.error('Make sure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.');
  process.exit(1);
}

async function main() {
  try {
    console.log('Testing Supabase connection and site_analysis table...');
    
    // Create Supabase client
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    // Test basic connection
    const { data: versionData, error: versionError } = await supabase.rpc('version');
    if (versionError) {
      console.error('ERROR: Could not connect to Supabase:');
      console.error(versionError);
      process.exit(1);
    }
    
    console.log(`✅ Connected to Supabase (PostgreSQL ${versionData || 'unknown version'})`);
    
    // Test if site_analysis table exists
    const { data, error } = await supabase
      .from('site_analysis')
      .select('id')
      .limit(1);
      
    if (error) {
      if (error.code === '42P01' || error.message.includes('does not exist')) {
        console.error('❌ The site_analysis table does not exist!');
        console.error('');
        console.error('Please create the table by running the SQL script:');
        console.error('');
        console.error('1. Go to the Supabase dashboard');
        console.error('2. Open the SQL Editor');
        console.error('3. Copy the contents of src/scripts/create_site_analysis_table.sql');
        console.error('4. Run the SQL script');
        console.error('');
        console.error('For more details, see docs/setup-site-analysis-database.md');
      } else {
        console.error('ERROR querying site_analysis table:');
        console.error(error);
      }
      process.exit(1);
    }
    
    console.log('✅ site_analysis table exists');
    
    // Try inserting a test record
    const testId = 'test-' + Date.now();
    const { data: insertData, error: insertError } = await supabase
      .from('site_analysis')
      .insert([
        {
          id: testId,
          site_id: '00000000-0000-0000-0000-000000000000',
          url_path: '/test',
          structure: { test: true },
          user_id: '00000000-0000-0000-0000-000000000000',
          status: 'processing',
          request_time: 0,
          provider: 'test',
          model_id: 'test'
        }
      ])
      .select();
    
    if (insertError) {
      console.error('❌ Could not insert test record:');
      console.error(insertError);
      
      if (insertError.code === '42501') {
        console.error('');
        console.error('This is likely a Row Level Security (RLS) error.');
        console.error('You may need to temporarily disable RLS for testing:');
        console.error('ALTER TABLE site_analysis DISABLE ROW LEVEL SECURITY;');
      }
      
      process.exit(1);
    }
    
    console.log('✅ Successfully inserted test record');
    
    // Clean up the test record
    const { error: deleteError } = await supabase
      .from('site_analysis')
      .delete()
      .eq('id', testId);
      
    if (deleteError) {
      console.warn('⚠️ Could not delete test record:');
      console.warn(deleteError);
    } else {
      console.log('✅ Successfully deleted test record');
    }
    
    console.log('');
    console.log('🎉 All tests passed! The site_analysis table is ready to use.');
    
  } catch (error) {
    console.error('Unexpected error during testing:');
    console.error(error);
    process.exit(1);
  }
}

main(); 