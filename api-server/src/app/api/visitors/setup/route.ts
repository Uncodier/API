import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/database/supabase-client'

/**
 * This endpoint creates the necessary tables for the visitors tracking system
 */
export async function GET(request: NextRequest) {
  console.log("[SETUP] Starting setup of visitors tables");
  
  try {
    // 1. First create the sites table
    console.log("[SETUP] Creating sites table...");
    
    const createSitesTableSQL = `
      CREATE TABLE IF NOT EXISTS sites (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      
      -- Create indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);
    `;
    
    console.log("[SETUP] Executing sites table creation SQL...");
    
    // Execute the SQL for sites
    const { error: sitesError } = await supabaseAdmin.rpc('pgSQL', { sql_string: createSitesTableSQL });
    
    if (sitesError) {
      console.error("[SETUP] Error creating sites table:", sitesError);
      
      // Try fallback method
      console.log("[SETUP] Trying fallback method for sites...");
      const { error: fallbackError } = await supabaseAdmin.rpc('execute_sql', { sql: createSitesTableSQL });
      
      if (fallbackError) {
        console.error("[SETUP] Fallback error for sites:", fallbackError);
        return NextResponse.json({
          success: false,
          message: "Failed to create sites table",
          error: sitesError || fallbackError
        }, { status: 500 });
      }
    }

    // 2. Create the visitors table
    console.log("[SETUP] Creating visitors table...");
    
    const createVisitorsTableSQL = `
      CREATE TABLE IF NOT EXISTS visitors (
        id UUID PRIMARY KEY,
        visitor_id UUID NOT NULL UNIQUE,
        first_seen_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        total_sessions INTEGER DEFAULT 1,
        total_page_views INTEGER DEFAULT 0,
        total_time_spent BIGINT DEFAULT 0,
        first_url TEXT,
        first_referrer TEXT,
        first_utm_source TEXT,
        first_utm_medium TEXT,
        first_utm_campaign TEXT,
        first_utm_term TEXT,
        first_utm_content TEXT,
        device JSONB,
        browser JSONB,
        location JSONB,
        custom_data JSONB,
        lead_id UUID,
        is_identified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE
      );
      
      -- Create indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_visitors_visitor_id ON visitors(visitor_id);
      CREATE INDEX IF NOT EXISTS idx_visitors_lead_id ON visitors(lead_id);
      CREATE INDEX IF NOT EXISTS idx_visitors_is_identified ON visitors(is_identified);
    `;
    
    console.log("[SETUP] Executing visitors table creation SQL...");
    
    // Execute the SQL for visitors
    const { error: visitorsError } = await supabaseAdmin.rpc('pgSQL', { sql_string: createVisitorsTableSQL });
    
    if (visitorsError) {
      console.error("[SETUP] Error creating visitors table:", visitorsError);
      
      // Try fallback method
      console.log("[SETUP] Trying fallback method for visitors...");
      const { error: fallbackError } = await supabaseAdmin.rpc('execute_sql', { sql: createVisitorsTableSQL });
      
      if (fallbackError) {
        console.error("[SETUP] Fallback error for visitors:", fallbackError);
        return NextResponse.json({
          success: false,
          message: "Failed to create visitors table",
          error: visitorsError || fallbackError
        }, { status: 500 });
      }
    }
    
    // 3. Create the visitor_sessions table
    console.log("[SETUP] Creating visitor_sessions table...");
    
    const createSessionsTableSQL = `
      CREATE TABLE IF NOT EXISTS visitor_sessions (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL UNIQUE,
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
          REFERENCES visitors(visitor_id)
          ON DELETE CASCADE
      );
      
      -- Create indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_visitor_sessions_session_id ON visitor_sessions(session_id);
      CREATE INDEX IF NOT EXISTS idx_visitor_sessions_visitor_id ON visitor_sessions(visitor_id);
      CREATE INDEX IF NOT EXISTS idx_visitor_sessions_site_id ON visitor_sessions(site_id);
      CREATE INDEX IF NOT EXISTS idx_visitor_sessions_is_active ON visitor_sessions(is_active);
    `;
    
    console.log("[SETUP] Executing visitor_sessions table creation SQL...");
    
    // Execute the SQL for sessions
    const { error: sessionsError } = await supabaseAdmin.rpc('pgSQL', { sql_string: createSessionsTableSQL });
    
    if (sessionsError) {
      console.error("[SETUP] Error creating visitor_sessions table:", sessionsError);
      
      // Try fallback method
      console.log("[SETUP] Trying fallback method for sessions...");
      const { error: fallbackError } = await supabaseAdmin.rpc('execute_sql', { sql: createSessionsTableSQL });
      
      if (fallbackError) {
        console.error("[SETUP] Fallback error for sessions:", fallbackError);
        return NextResponse.json({
          success: false,
          message: "Failed to create visitor_sessions table",
          error: sessionsError || fallbackError
        }, { status: 500 });
      }
    }
    
    // 4. Create the visitor_events table
    console.log("[SETUP] Creating visitor_events table...");
    
    const createEventsTableSQL = `
      CREATE TABLE IF NOT EXISTS visitor_events (
        id UUID PRIMARY KEY,
        event_id UUID NOT NULL UNIQUE,
        session_id UUID NOT NULL,
        visitor_id UUID NOT NULL,
        site_id UUID NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        event_name VARCHAR(100) NOT NULL,
        url TEXT,
        timestamp BIGINT NOT NULL,
        event_data JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT fk_session
          FOREIGN KEY(session_id)
          REFERENCES visitor_sessions(session_id)
          ON DELETE CASCADE,
        CONSTRAINT fk_visitor
          FOREIGN KEY(visitor_id)
          REFERENCES visitors(visitor_id)
          ON DELETE CASCADE,
        CONSTRAINT valid_event_type CHECK (
          event_type IN (
            'pageview', 'click', 'custom', 'purchase', 'action',
            'mousemove', 'scroll', 'keypress', 'resize', 'focus',
            'blur', 'form_submit', 'form_change', 'form_error',
            'error', 'performance', 'session_recording'
          )
        )
      );
      
      -- Create indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_visitor_events_event_id ON visitor_events(event_id);
      CREATE INDEX IF NOT EXISTS idx_visitor_events_session_id ON visitor_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_visitor_events_visitor_id ON visitor_events(visitor_id);
      CREATE INDEX IF NOT EXISTS idx_visitor_events_event_type ON visitor_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_visitor_events_timestamp ON visitor_events(timestamp);
    `;
    
    console.log("[SETUP] Executing visitor_events table creation SQL...");
    
    // Execute the SQL for events
    const { error: eventsError } = await supabaseAdmin.rpc('pgSQL', { sql_string: createEventsTableSQL });
    
    if (eventsError) {
      console.error("[SETUP] Error creating visitor_events table:", eventsError);
      
      // Try fallback method
      console.log("[SETUP] Trying fallback method for events...");
      const { error: fallbackError } = await supabaseAdmin.rpc('execute_sql', { sql: createEventsTableSQL });
      
      if (fallbackError) {
        console.error("[SETUP] Fallback error for events:", fallbackError);
        // Continue anyway as this is not critical
      }
    }
    
    // Verify the tables were created
    const tables = ['visitors', 'visitor_sessions', 'visitor_events'];
    const verificationResults: Record<string, { success: boolean, error?: any }> = {};
    let anyFailures = false;
    
    for (const table of tables) {
      try {
        const { error } = await supabaseAdmin
          .from(table)
          .select('count(*)')
          .limit(1);
        
        if (error) {
          console.error(`[SETUP] Verification failed for ${table}:`, error);
          verificationResults[table] = { success: false, error };
          anyFailures = true;
        } else {
          console.log(`[SETUP] Table ${table} created successfully`);
          verificationResults[table] = { success: true };
        }
      } catch (e) {
        console.error(`[SETUP] Exception verifying ${table}:`, e);
        verificationResults[table] = { success: false, error: e };
        anyFailures = true;
      }
    }
    
    if (anyFailures) {
      return NextResponse.json({
        success: false,
        message: "Some tables may not have been created correctly",
        verification: verificationResults
      }, { status: 500 });
    }
    
    return NextResponse.json({
      success: true,
      message: "All visitors tracking tables created successfully",
      verification: verificationResults
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