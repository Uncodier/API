import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/database/supabase-client'

/**
 * Endpoint to add unique constraints to the leads table.
 * This ensures atomic upsert operations work correctly and prevents duplication.
 */
export async function GET(request: NextRequest) {
  console.log("[SETUP-CONSTRAINTS] Starting setup of lead unique constraints");
  
  try {
    const sql = `
      -- 1. Clean up existing duplicates (keep the most recent one)
      DELETE FROM public.leads a USING public.leads b
      WHERE a.id < b.id 
        AND a.site_id = b.site_id 
        AND COALESCE(a.name, '') = COALESCE(b.name, '') 
        AND COALESCE(a.email, '') = COALESCE(b.email, '')
        AND a.site_id IS NOT NULL;

      -- 2. Add the unique constraint
      -- We use COALESCE or ensure they are NOT NULL to avoid multiple NULLs bypassing the constraint
      -- Based on the schema, name and email are already NOT NULL.
      ALTER TABLE public.leads 
      DROP CONSTRAINT IF EXISTS leads_site_name_email_unique;
      
      ALTER TABLE public.leads 
      ADD CONSTRAINT leads_site_name_email_unique UNIQUE (site_id, name, email);
    `;
    
    console.log("[SETUP-CONSTRAINTS] Executing SQL...");
    
    // Execute using the pgSQL RPC if available, or execute_sql
    const { error } = await supabaseAdmin.rpc('pgSQL', { sql_string: sql });
    
    if (error) {
      console.error("[SETUP-CONSTRAINTS] Error:", error);
      // Try fallback
      const { error: fallbackError } = await supabaseAdmin.rpc('execute_sql', { sql });
      if (fallbackError) {
        throw fallbackError;
      }
    }

    return NextResponse.json({
      success: true,
      message: "Unique constraint 'leads_site_name_email_unique' added successfully"
    });

  } catch (error) {
    console.error("[SETUP-CONSTRAINTS] Unexpected error:", error);
    return NextResponse.json({
      success: false,
      message: "Setup failed",
      error: error instanceof Error ? error.message : error
    }, { status: 500 });
  }
}
