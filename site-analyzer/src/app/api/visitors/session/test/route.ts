import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/database/supabase-client'

/**
 * This is a test endpoint to check the database connection and table schema
 */
export async function GET(request: NextRequest) {
  console.log("[TEST /api/visitors/session/test] Starting test endpoint");
  try {
    // Check overall database connection
    console.log("[TEST] Testing database connection...");
    const { data: databaseCheck, error: databaseError } = await supabaseAdmin
      .from('_prisma_migrations') // Most Supabase projects have this table
      .select('*')
      .limit(1);
    
    console.log("[TEST] Database connection status:", databaseError ? "Failed" : "Successful");
    
    // List all tables to see if visitor_sessions exists
    console.log("[TEST] Listing all tables...");
    let tables = [];
    let tableListError = null;
    try {
      const { data, error } = await supabaseAdmin.rpc('get_tables');
      if (error) {
        console.error("[TEST] Error getting tables:", error);
        tableListError = error;
      } else {
        tables = data || [];
        console.log("[TEST] Tables found:", tables);
      }
    } catch (err) {
      console.error("[TEST] Exception getting tables:", err);
      
      // Fallback approach: try another method to list tables
      try {
        const { data, error } = await supabaseAdmin
          .from('pg_tables')
          .select('tablename')
          .eq('schemaname', 'public');
        
        if (error) {
          console.error("[TEST] Error getting tables (fallback):", error);
        } else {
          tables = data?.map(t => t.tablename) || [];
          console.log("[TEST] Tables found (fallback):", tables);
        }
      } catch (fallbackErr) {
        console.error("[TEST] Exception getting tables (fallback):", fallbackErr);
      }
    }
    
    // Check if visitor_sessions exists
    const visitorSessionsExists = tables.includes('visitor_sessions');
    console.log("[TEST] visitor_sessions table exists:", visitorSessionsExists);
    
    // Try to get table info if the table exists
    let schema = null;
    let schemaError = null;
    if (visitorSessionsExists) {
      // Get table schema
      console.log("[TEST] Getting visitor_sessions schema...");
      try {
        const { data, error } = await supabaseAdmin
          .from('visitor_sessions')
          .select('*')
          .limit(1);
        
        if (error) {
          console.error("[TEST] Error getting schema:", error);
          schemaError = error;
        } else {
          // If we got data, extract the column names from the first record
          if (data && data.length > 0) {
            schema = Object.keys(data[0]);
          }
        }
      } catch (err) {
        console.error("[TEST] Exception getting schema:", err);
      }
    }
    
    return NextResponse.json({
      success: true,
      databaseConnection: {
        connected: !databaseError,
        error: databaseError
      },
      tableInfo: {
        allTables: tables,
        visitor_sessions_exists: visitorSessionsExists,
        error: tableListError
      },
      schema: schema,
      schemaError: schemaError,
      recommendation: !visitorSessionsExists ? 
        "The 'visitor_sessions' table doesn't exist. You need to create it first." : 
        "Table exists, check schema for details."
    });
    
  } catch (error: any) {
    console.error("[TEST] Unexpected error:", error);
    return NextResponse.json({
      success: false,
      error: {
        message: "Test failed with error",
        details: error.message
      }
    }, { status: 500 });
  }
} 