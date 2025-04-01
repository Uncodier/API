import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/database/supabase-client'

/**
 * This endpoint creates the necessary tables for the visitor identification system
 */
export async function GET(request: NextRequest) {
  console.log("[SETUP] Starting setup of visitor identification tables");
  
  try {
    // 1. First create the leads table
    console.log("[SETUP] Creating leads table...");
    
    const createLeadsTableSQL = `
      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY,
        site_id UUID NOT NULL,
        traits JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT fk_site
          FOREIGN KEY(site_id)
          REFERENCES sites(id)
          ON DELETE CASCADE
      );
      
      -- Create indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_leads_site_id ON leads(site_id);
      CREATE INDEX IF NOT EXISTS idx_leads_traits ON leads USING GIN (traits);
    `;
    
    console.log("[SETUP] Executing leads table creation SQL...");
    
    // Execute the SQL for leads
    const { error: leadsError } = await supabaseAdmin.rpc('pgSQL', { sql_string: createLeadsTableSQL });
    
    if (leadsError) {
      console.error("[SETUP] Error creating leads table:", leadsError);
      
      // Try fallback method
      console.log("[SETUP] Trying fallback method for leads...");
      const { error: fallbackError } = await supabaseAdmin.rpc('execute_sql', { sql: createLeadsTableSQL });
      
      if (fallbackError) {
        console.error("[SETUP] Fallback error for leads:", fallbackError);
        return NextResponse.json({
          success: false,
          message: "Failed to create leads table",
          error: leadsError || fallbackError
        }, { status: 500 });
      }
    }
    
    // 2. Add identification columns to visitors table
    console.log("[SETUP] Adding identification columns to visitors table...");
    
    const alterVisitorsTableSQL = `
      ALTER TABLE visitors
      ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS traits JSONB,
      ADD COLUMN IF NOT EXISTS is_identified BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS last_identified_at TIMESTAMP WITH TIME ZONE;
      
      -- Create indexes for identification columns
      CREATE INDEX IF NOT EXISTS idx_visitors_lead_id ON visitors(lead_id);
      CREATE INDEX IF NOT EXISTS idx_visitors_is_identified ON visitors(is_identified);
      CREATE INDEX IF NOT EXISTS idx_visitors_traits ON visitors USING GIN (traits);
    `;
    
    console.log("[SETUP] Executing visitors table alteration SQL...");
    
    // Execute the SQL for visitors
    const { error: visitorsError } = await supabaseAdmin.rpc('pgSQL', { sql_string: alterVisitorsTableSQL });
    
    if (visitorsError) {
      console.error("[SETUP] Error altering visitors table:", visitorsError);
      
      // Try fallback method
      console.log("[SETUP] Trying fallback method for visitors...");
      const { error: fallbackError } = await supabaseAdmin.rpc('execute_sql', { sql: alterVisitorsTableSQL });
      
      if (fallbackError) {
        console.error("[SETUP] Fallback error for visitors:", fallbackError);
        return NextResponse.json({
          success: false,
          message: "Failed to alter visitors table",
          error: visitorsError || fallbackError
        }, { status: 500 });
      }
    }
    
    // Verify the tables were created
    let verificationError = null;
    try {
      const { error: verifyLeadsError } = await supabaseAdmin
        .from('leads')
        .select('count(*)')
        .limit(1);
      
      if (verifyLeadsError) {
        verificationError = verifyLeadsError;
      }
      
      const { error: verifyVisitorsError } = await supabaseAdmin
        .from('visitors')
        .select('count(*)')
        .limit(1);
      
      if (verifyVisitorsError) {
        verificationError = verifyVisitorsError;
      }
    } catch (e) {
      verificationError = e;
    }
    
    if (verificationError) {
      console.error("[SETUP] Verification failed:", verificationError);
      return NextResponse.json({
        success: false,
        message: "Table creation might have failed",
        error: verificationError
      }, { status: 500 });
    }
    
    console.log("[SETUP] Visitor identification tables created successfully");
    return NextResponse.json({
      success: true,
      message: "Visitor identification tables created successfully",
      status: "created"
    });
    
  } catch (error) {
    console.error("[SETUP] Unexpected error:", error);
    return NextResponse.json({
      success: false,
      message: "Setup failed with unexpected error",
      error
    }, { status: 500 });
  }
} 