const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_APPS_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.APPS_SUPABASE_SERVICE_KEY || process.env.REPOSITORY_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

async function run() {
  const db = createClient(url, key);
  
  const exposeSql = `
    do $$
    declare
      current_schemas text;
    begin
      select string_agg(nspname, ',') into current_schemas
      from pg_namespace
      where nspname like 'app_%' or nspname in ('public', 'graphql_public', 'storage');
      
      execute format('alter role authenticator set pgrst.db_schemas = %L', current_schemas);
    end $$;
    notify pgrst, 'reload config';
  `;
  
  const { error } = await db.rpc('apps_exec_sql', { sql: exposeSql });
  console.log('Expose result:', error ? error.message : 'Success');
}

run().catch(console.error);
