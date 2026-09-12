import { getAppsAdminClient } from '@/lib/database/apps-supabase';

export async function syncPostgrestSchemas(): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = getAppsAdminClient();
    
    const { data: tenants, error: tenantsError } = await client
      .from('apps_tenants')
      .select('schema');
      
    if (tenantsError) {
      return { ok: false, error: `Failed to fetch tenant schemas: ${tenantsError.message}` };
    }

    const appSchemas = tenants.map((t: { schema: string }) => t.schema);
    const db_schema = ['public', 'graphql_public', 'storage', ...appSchemas].join(',');

    const url = process.env.REPOSITORY_SUPABASE_URL || process.env.APPS_SUPABASE_URL;
    if (!url) {
      return { ok: false, error: 'REPOSITORY_SUPABASE_URL is not set' };
    }
    
    // Extract project ref from URL (e.g., https://ref.supabase.co)
    const match = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
    if (!match || !match[1]) {
      return { ok: false, error: 'Could not extract Supabase project ref from URL' };
    }
    const projectRef = match[1];

    const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
    if (!accessToken) {
      return { ok: false, error: 'SUPABASE_ACCESS_TOKEN is not set' };
    }

    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/postgrest`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ db_schema })
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { ok: false, error: `Management API error (${res.status}): ${errorText}` };
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}
