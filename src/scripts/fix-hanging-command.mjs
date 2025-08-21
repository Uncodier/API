#!/usr/bin/env node

/**
 * Script to fix hanging commands by checking their status and attempting recovery
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

// Load environment variables
config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing Supabase environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function checkCommandStatus(commandId) {
  console.log(`🔍 Checking command status for: ${commandId}`);
  
  try {
    // Check if it's a UUID (database ID) or internal ID
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId);
    
    if (isUUID) {
      console.log(`📋 Command ${commandId} is a UUID, checking in database...`);
      
      const { data: command, error } = await supabase
        .from('commands')
        .select('*')
        .eq('id', commandId)
        .single();
      
      if (error) {
        console.error(`❌ Error fetching command from database:`, error);
        return null;
      }
      
      if (!command) {
        console.log(`📋 Command ${commandId} not found in database`);
        return null;
      }
      
      console.log(`📋 Command found in database:`);
      console.log(`   Status: ${command.status}`);
      console.log(`   Created: ${command.created_at}`);
      console.log(`   Updated: ${command.updated_at}`);
      console.log(`   Agent Background: ${command.agent_background ? `${command.agent_background.length} characters` : 'None'}`);
      console.log(`   Results: ${command.results ? `${command.results.length} items` : 'None'}`);
      
      return command;
    } else {
      console.log(`📋 Command ${commandId} appears to be an internal ID`);
      return null;
    }
  } catch (error) {
    console.error(`❌ Error checking command status:`, error);
    return null;
  }
}

async function fixHangingCommand(commandId) {
  console.log(`🔧 Attempting to fix hanging command: ${commandId}`);
  
  const command = await checkCommandStatus(commandId);
  
  if (!command) {
    console.log(`❌ Cannot fix command - not found or not accessible`);
    return false;
  }
  
  // Check if command is actually hanging (pending status for too long)
  const createdAt = new Date(command.created_at);
  const now = new Date();
  const ageInMinutes = (now - createdAt) / (1000 * 60);
  
  console.log(`⏰ Command age: ${ageInMinutes.toFixed(2)} minutes`);
  
  if (command.status === 'pending' && ageInMinutes > 5) {
    console.log(`🚨 Command appears to be hanging (pending for ${ageInMinutes.toFixed(2)} minutes)`);
    
    console.log(`🔍 Debug: agent_background=${!!command.agent_background}, results=${command.results ? command.results.length : 0}`);
    
    // Check if there's partial content or agent_background
    if (command.agent_background && !command.results) {
      console.log(`🔄 Command has agent_background but no results - may be stuck in processing`);
      
      // Update status to failed with timeout reason
      const { error: updateError } = await supabase
        .from('commands')
        .update({
          status: 'failed',
          description: `Command timed out after ${ageInMinutes.toFixed(2)} minutes. StreamingResponseProcessor may have hung.`,
          updated_at: new Date().toISOString()
        })
        .eq('id', commandId);
      
      if (updateError) {
        console.error(`❌ Error updating command status:`, updateError);
        return false;
      }
      
      console.log(`✅ Command status updated to 'failed' with timeout reason`);
      return true;
    }
    
    if (command.results && command.results.length > 0) {
      console.log(`🔄 Command has results but status is still pending - updating to completed`);
      
      const { error: updateError } = await supabase
        .from('commands')
        .update({
          status: 'completed',
          updated_at: new Date().toISOString()
        })
        .eq('id', commandId);
      
      if (updateError) {
        console.error(`❌ Error updating command status:`, updateError);
        return false;
      }
      
      console.log(`✅ Command status updated to 'completed'`);
      return true;
    }
    
    // Special case: Command is pending without agent_background for too long
    console.log(`🔍 Checking special case: !agent_background=${!command.agent_background}, !results=${!command.results}`);
    if (!command.agent_background && (!command.results || command.results.length === 0)) {
      console.log(`🚨 Command is stuck without agent_background - likely initialization failure`);
      
      const { error: updateError } = await supabase
        .from('commands')
        .update({
          status: 'failed',
          description: `Command initialization failed after ${ageInMinutes.toFixed(2)} minutes. No agent_background generated.`,
          updated_at: new Date().toISOString()
        })
        .eq('id', commandId);
      
      if (updateError) {
        console.error(`❌ Error updating command status:`, updateError);
        return false;
      }
      
      console.log(`✅ Command status updated to 'failed' due to initialization failure`);
      return true;
    }
  } else if (command.status === 'completed') {
    console.log(`✅ Command is already completed`);
    return true;
  } else if (command.status === 'failed') {
    console.log(`❌ Command has already failed`);
    return false;
  } else {
    console.log(`⏳ Command appears to be processing normally (age: ${ageInMinutes.toFixed(2)} minutes)`);
    return false;
  }
  
  return false;
}

// Main execution
async function main() {
  const commandId = process.argv[2];
  
  if (!commandId) {
    console.log(`Usage: node fix-hanging-command.mjs <command-id>`);
    console.log(`Example: node fix-hanging-command.mjs 5d7799cc-e1d1-4ec7-a86f-d9dca9ec6366`);
    process.exit(1);
  }
  
  console.log(`🚀 Starting hanging command fix for: ${commandId}`);
  
  const fixed = await fixHangingCommand(commandId);
  
  if (fixed) {
    console.log(`✅ Command ${commandId} has been fixed`);
  } else {
    console.log(`⚠️ Command ${commandId} could not be fixed or doesn't need fixing`);
  }
  
  // Final status check
  await checkCommandStatus(commandId);
}

main().catch(console.error);
