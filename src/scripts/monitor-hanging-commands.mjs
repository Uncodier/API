#!/usr/bin/env node

/**
 * Script to monitor and automatically fix hanging commands
 * This script should be run periodically (e.g., every 5 minutes) to detect and fix hanging commands
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

async function findHangingCommands() {
  console.log('🔍 Searching for hanging commands...');
  
  try {
    // Find commands that are pending for more than 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    
    const { data: hangingCommands, error } = await supabase
      .from('commands')
      .select('*')
      .eq('status', 'pending')
      .lt('created_at', fiveMinutesAgo)
      .order('created_at', { ascending: true });
    
    if (error) {
      console.error('❌ Error fetching hanging commands:', error);
      return [];
    }
    
    console.log(`📋 Found ${hangingCommands?.length || 0} potentially hanging commands`);
    
    return hangingCommands || [];
  } catch (error) {
    console.error('❌ Error in findHangingCommands:', error);
    return [];
  }
}

async function fixHangingCommand(command) {
  const ageInMinutes = (Date.now() - new Date(command.created_at)) / (1000 * 60);
  
  console.log(`🔧 Fixing hanging command ${command.id} (age: ${ageInMinutes.toFixed(2)} minutes)`);
  
  let updateData = {
    status: 'failed',
    updated_at: new Date().toISOString()
  };
  
  // Determine the reason for failure based on command state
  if (!command.agent_background && (!command.results || command.results.length === 0)) {
    updateData.description = `Command initialization failed after ${ageInMinutes.toFixed(2)} minutes. No agent_background generated.`;
    console.log(`  📝 Reason: Initialization failure (no agent_background)`);
  } else if (command.agent_background && (!command.results || command.results.length === 0)) {
    updateData.description = `Command processing failed after ${ageInMinutes.toFixed(2)} minutes. StreamingResponseProcessor may have hung.`;
    console.log(`  📝 Reason: Processing failure (has agent_background but no results)`);
  } else if (command.results && command.results.length > 0) {
    // This command has results but is still pending - mark as completed
    updateData.status = 'completed';
    delete updateData.description; // Don't overwrite description for completed commands
    console.log(`  📝 Reason: Has results but status is pending - marking as completed`);
  }
  
  const { error: updateError } = await supabase
    .from('commands')
    .update(updateData)
    .eq('id', command.id);
  
  if (updateError) {
    console.error(`❌ Error updating command ${command.id}:`, updateError);
    return false;
  }
  
  console.log(`✅ Command ${command.id} fixed with status: ${updateData.status}`);
  return true;
}

async function monitorAndFix() {
  console.log('🚀 Starting hanging commands monitor...');
  console.log(`⏰ Current time: ${new Date().toISOString()}`);
  
  const hangingCommands = await findHangingCommands();
  
  if (hangingCommands.length === 0) {
    console.log('✅ No hanging commands found');
    return;
  }
  
  console.log(`🔧 Processing ${hangingCommands.length} hanging commands...`);
  
  let fixedCount = 0;
  let failedCount = 0;
  
  for (const command of hangingCommands) {
    try {
      const fixed = await fixHangingCommand(command);
      if (fixed) {
        fixedCount++;
      } else {
        failedCount++;
      }
    } catch (error) {
      console.error(`❌ Error processing command ${command.id}:`, error);
      failedCount++;
    }
  }
  
  console.log(`📊 Summary: ${fixedCount} fixed, ${failedCount} failed`);
  
  if (fixedCount > 0) {
    console.log(`🎉 Successfully fixed ${fixedCount} hanging commands`);
  }
  
  if (failedCount > 0) {
    console.log(`⚠️ Failed to fix ${failedCount} commands`);
  }
}

// Main execution
async function main() {
  try {
    await monitorAndFix();
  } catch (error) {
    console.error('❌ Fatal error in monitor:', error);
    process.exit(1);
  }
}

main().catch(console.error);
