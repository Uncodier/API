import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/database/supabase-client'

/**
 * This endpoint creates the visitor_sessions table in the database
 */
export async function GET(request: NextRequest) {
  console.log("[SETUP] Starting setup of visitor_sessions table");
  
  try {
    // First check if the table already exists
    let tableExists = false;
    try {
      const { data, error } = await supabaseAdmin
        .from('visitor_sessions')
        .select('count(*)')
        .limit(1);
      
      if (!error) {
        tableExists = true;
        console.log("[SETUP] Table visitor_sessions already exists");
      }
    } catch (e) {
      console.log("[SETUP] Table visitor_sessions does not exist yet");
    }
    
    if (tableExists) {
      return NextResponse.json({
        success: true,
        message: "Table visitor_sessions already exists",
        status: "exists"
      });
    }
    
    // Create the table using SQL
    console.log("[SETUP] Creating visitor_sessions table...");
    
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS visitor_sessions (
        id UUID PRIMARY KEY,
        visitor_id UUID NOT NULL,
        site_id UUID NOT NULL,
        landing_url TEXT,
        current_url TEXT,
        referrer TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        utm_term TEXT,
        utm_content TEXT,
        started_at BIGINT NOT NULL,
        last_activity_at BIGINT NOT NULL,
        page_views INTEGER DEFAULT 1,
        device JSONB,
        browser JSONB,
        location JSONB,
        previous_session_id UUID,
        performance JSONB,
        consent JSONB,
        is_active BOOLEAN DEFAULT TRUE,
        duration BIGINT,
        active_time BIGINT,
        idle_time BIGINT,
        lead_id UUID,
        exit_url TEXT,
        exit_type TEXT,
        custom_data JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE,
        CONSTRAINT fk_visitor
          FOREIGN KEY(visitor_id)
          REFERENCES visitors(id)
          ON DELETE CASCADE
      );
      
      -- Create indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_visitor_sessions_visitor_id ON visitor_sessions(visitor_id);
      CREATE INDEX IF NOT EXISTS idx_visitor_sessions_site_id ON visitor_sessions(site_id);
      CREATE INDEX IF NOT EXISTS idx_visitor_sessions_is_active ON visitor_sessions(is_active);
    `;
    
    // Execute the SQL
    const { error } = await supabaseAdmin.rpc('pgSQL', { sql_string: createTableSQL });
    
    if (error) {
      console.error("[SETUP] Error creating table:", error);
      
      // Try fallback method
      console.log("[SETUP] Trying fallback method...");
      const { error: fallbackError } = await supabaseAdmin.rpc('execute_sql', { sql: createTableSQL });
      
      if (fallbackError) {
        console.error("[SETUP] Fallback error:", fallbackError);
        return NextResponse.json({
          success: false,
          message: "Failed to create table visitor_sessions",
          error: error || fallbackError
        }, { status: 500 });
      }
    }
    
    // Verify the table was created
    let verificationError = null;
    try {
      const { error: verifyError } = await supabaseAdmin
        .from('visitor_sessions')
        .select('count(*)')
        .limit(1);
      
      verificationError = verifyError;
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
    
    console.log("[SETUP] visitor_sessions table created successfully");
    return NextResponse.json({
      success: true,
      message: "Table visitor_sessions created successfully",
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