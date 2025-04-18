import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(request: NextRequest) {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ 
      success: false, 
      message: "Server configuration error: Missing Supabase credentials" 
    }, { status: 500 });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    console.log("[SETUP] Creating messages and conversations tables...");
    
    const createMessagingTablesSQL = `
      -- Create conversations table
      CREATE TABLE IF NOT EXISTS conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          visitor_id UUID,
          agent_id UUID,
          user_id UUID,
          lead_id UUID,
          site_id UUID,
          status TEXT DEFAULT 'active',
          title TEXT,
          custom_data JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          last_message_at TIMESTAMPTZ,
          CONSTRAINT fk_visitor
              FOREIGN KEY(visitor_id)
              REFERENCES visitors(id)
              ON DELETE SET NULL,
          CONSTRAINT fk_lead
              FOREIGN KEY(lead_id)
              REFERENCES leads(id)
              ON DELETE SET NULL
      );
      
      -- Add indexes for conversations
      CREATE INDEX IF NOT EXISTS idx_conversations_visitor_id ON conversations(visitor_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_lead_id ON conversations(lead_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_site_id ON conversations(site_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
      CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at);
      
      -- Create messages table
      CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          conversation_id UUID NOT NULL,
          visitor_id UUID,
          agent_id UUID,
          user_id UUID,
          lead_id UUID,
          command_id UUID,
          content TEXT NOT NULL,
          sender_type TEXT NOT NULL,
          read_at TIMESTAMPTZ,
          custom_data JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_conversation
              FOREIGN KEY(conversation_id)
              REFERENCES conversations(id)
              ON DELETE CASCADE,
          CONSTRAINT fk_visitor
              FOREIGN KEY(visitor_id)
              REFERENCES visitors(id)
              ON DELETE SET NULL,
          CONSTRAINT fk_lead
              FOREIGN KEY(lead_id)
              REFERENCES leads(id)
              ON DELETE SET NULL,
          CONSTRAINT valid_sender_type CHECK (
              sender_type IN (
                  'visitor', 'agent', 'user', 'system'
              )
          )
      );
      
      -- Add indexes for messages
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_visitor_id ON messages(visitor_id);
      CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);
      CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
      CREATE INDEX IF NOT EXISTS idx_messages_command_id ON messages(command_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_type ON messages(sender_type);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      
      -- Create function to update conversation last_message_at when new message is added
      CREATE OR REPLACE FUNCTION update_conversation_last_message_time()
      RETURNS TRIGGER AS $$
      BEGIN
          UPDATE conversations
          SET last_message_at = NEW.created_at,
              updated_at = NOW()
          WHERE id = NEW.conversation_id;
          
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      
      -- Create trigger for conversation update on message insert
      DROP TRIGGER IF EXISTS on_message_insert ON messages;
      CREATE TRIGGER on_message_insert
          AFTER INSERT ON messages
          FOR EACH ROW
          EXECUTE FUNCTION update_conversation_last_message_time();
      
      -- Add RLS policies
      ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
      
      -- Create policies for conversations
      CREATE POLICY "Enable read access for authenticated users" ON conversations
          FOR SELECT
          TO authenticated
          USING (true);
      
      CREATE POLICY "Enable insert for authenticated users" ON conversations
          FOR INSERT
          TO authenticated
          WITH CHECK (true);
      
      CREATE POLICY "Enable update for authenticated users" ON conversations
          FOR UPDATE
          TO authenticated
          USING (true);
      
      -- Create policies for messages
      CREATE POLICY "Enable read access for authenticated users" ON messages
          FOR SELECT
          TO authenticated
          USING (true);
      
      CREATE POLICY "Enable insert for authenticated users" ON messages
          FOR INSERT
          TO authenticated
          WITH CHECK (true);
      
      CREATE POLICY "Enable update for authenticated users" ON messages
          FOR UPDATE
          TO authenticated
          USING (true);
    `;
    
    console.log("[SETUP] Executing messaging tables creation SQL...");
    
    // Execute the SQL for messaging tables
    const { error: messagingError } = await supabaseAdmin.rpc('pgSQL', { sql_string: createMessagingTablesSQL });
    
    if (messagingError) {
      console.error("[SETUP] Error creating messaging tables:", messagingError);
      
      // Try fallback method
      console.log("[SETUP] Trying fallback method for messaging tables...");
      const { error: fallbackError } = await supabaseAdmin.rpc('execute_sql', { sql: createMessagingTablesSQL });
      
      if (fallbackError) {
        console.error("[SETUP] Fallback error for messaging tables:", fallbackError);
        return NextResponse.json({
          success: false,
          message: "Failed to create messaging tables",
          error: messagingError || fallbackError
        }, { status: 500 });
      }
    }
    
    // Verify the tables were created
    const tables = ['conversations', 'messages'];
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
      message: "All messaging tables created successfully",
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