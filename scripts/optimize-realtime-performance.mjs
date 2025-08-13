#!/usr/bin/env node

/**
 * Supabase Realtime Performance Optimization Script
 * 
 * This script helps monitor and optimize the performance of Supabase Realtime
 * specifically targeting the slow realtime.list_changes function.
 * 
 * Usage:
 *   node scripts/optimize-realtime-performance.mjs [command]
 * 
 * Commands:
 *   monitor    - Show current realtime performance metrics
 *   optimize   - Run optimization functions
 *   cleanup    - Clean up old realtime data
 *   analyze    - Analyze query performance
 *   suggest    - Show PostgreSQL setting suggestions
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

// Load environment variables
config();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing required environment variables:');
  console.error('   NEXT_PUBLIC_SUPABASE_URL');
  console.error('   SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Monitor current realtime performance
 */
async function monitorPerformance() {
  console.log('📊 Monitoring Realtime Performance...\n');
  
  try {
    // Get performance metrics
    const { data: metrics, error } = await supabase
      .rpc('monitor_realtime_performance');
    
    if (error) {
      throw error;
    }
    
    console.log('🔍 Current Metrics:');
    console.log('─'.repeat(80));
    
    for (const metric of metrics) {
      const statusIcon = metric.status === 'OK' ? '✅' : '⚠️';
      console.log(`${statusIcon} ${metric.metric_name}: ${metric.metric_value}`);
      console.log(`   Status: ${metric.status}`);
      console.log(`   Recommendation: ${metric.recommendation}\n`);
    }
    
    // Get active conversations count
    const { data: conversations, error: convError } = await supabase
      .from('realtime_active_conversations')
      .select('*', { count: 'exact', head: true });
    
    if (!convError) {
      console.log(`💬 Active Conversations: ${conversations || 0}`);
    }
    
    // Get recent session events count
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    const { data: events, error: eventError } = await supabase
      .from('session_events')
      .select('*', { count: 'exact', head: true })
      .gt('timestamp', fiveMinutesAgo);
    
    if (!eventError) {
      console.log(`📈 Recent Events (5min): ${events || 0}`);
    }
    
  } catch (error) {
    console.error('❌ Error monitoring performance:', error.message);
  }
}

/**
 * Run optimization functions
 */
async function runOptimizations() {
  console.log('🚀 Running Realtime Optimizations...\n');
  
  try {
    // Run table analysis
    console.log('📊 Analyzing table statistics...');
    const { error: analyzeError } = await supabase
      .rpc('optimize_realtime_subscriptions');
    
    if (analyzeError) {
      console.error('❌ Error running analysis:', analyzeError.message);
    } else {
      console.log('✅ Table analysis completed');
    }
    
    // Refresh materialized view
    console.log('🔄 Refreshing performance summary...');
    const { error: refreshError } = await supabase
      .rpc('refresh_realtime_performance_summary');
    
    if (refreshError) {
      console.error('❌ Error refreshing summary:', refreshError.message);
    } else {
      console.log('✅ Performance summary refreshed');
    }
    
    console.log('\n🎉 Optimizations completed successfully!');
    
  } catch (error) {
    console.error('❌ Error running optimizations:', error.message);
  }
}

/**
 * Clean up old realtime data
 */
async function cleanupOldData(retentionHours = 72) {
  console.log(`🧹 Cleaning up realtime data older than ${retentionHours} hours...\n`);
  
  try {
    const { data: result, error } = await supabase
      .rpc('cleanup_old_realtime_data', { retention_hours: retentionHours });
    
    if (error) {
      throw error;
    }
    
    console.log(`✅ Cleaned up ${result} old records`);
    
  } catch (error) {
    console.error('❌ Error cleaning up data:', error.message);
  }
}

/**
 * Analyze query performance
 */
async function analyzeQueries() {
  console.log('🔍 Analyzing Query Performance...\n');
  
  try {
    // Check for slow queries in the last hour
    const { data: slowQueries, error } = await supabase
      .from('commands')
      .select('task, duration, status, created_at')
      .gt('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .gt('duration', 5000) // More than 5 seconds
      .order('duration', { ascending: false })
      .limit(10);
    
    if (error) {
      throw error;
    }
    
    if (slowQueries && slowQueries.length > 0) {
      console.log('🐌 Recent Slow Queries (> 5s):');
      console.log('─'.repeat(80));
      
      for (const query of slowQueries) {
        console.log(`⏱️  Duration: ${(query.duration / 1000).toFixed(2)}s`);
        console.log(`📝 Task: ${query.task.substring(0, 100)}...`);
        console.log(`📅 Created: ${new Date(query.created_at).toLocaleString()}`);
        console.log(`📊 Status: ${query.status}\n`);
      }
    } else {
      console.log('✅ No slow queries detected in the last hour');
    }
    
    // Check database size and growth
    const { data: tableStats, error: statsError } = await supabase
      .rpc('get_table_stats')
      .catch(() => null);
    
    if (!statsError && tableStats) {
      console.log('\n📊 Table Statistics:');
      console.log('─'.repeat(50));
      for (const stat of tableStats) {
        console.log(`📋 ${stat.table_name}: ${stat.row_count} rows`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error analyzing queries:', error.message);
  }
}

/**
 * Show PostgreSQL setting suggestions
 */
async function showSuggestions() {
  console.log('💡 PostgreSQL Setting Suggestions for Realtime Performance...\n');
  
  try {
    const { data: suggestions, error } = await supabase
      .rpc('suggest_realtime_pg_settings');
    
    if (error) {
      throw error;
    }
    
    console.log('⚙️  Recommended Settings:');
    console.log('─'.repeat(80));
    
    for (const setting of suggestions) {
      const status = setting.current_value === setting.suggested_value ? '✅' : '⚠️';
      console.log(`${status} ${setting.setting_name}:`);
      console.log(`   Current: ${setting.current_value}`);
      console.log(`   Suggested: ${setting.suggested_value}`);
      console.log(`   Description: ${setting.description}\n`);
    }
    
    console.log('📝 Note: These settings may require Supabase support assistance to modify.');
    
  } catch (error) {
    console.error('❌ Error getting suggestions:', error.message);
  }
}

/**
 * Show usage help
 */
function showHelp() {
  console.log(`
🚀 Supabase Realtime Performance Optimizer

Usage: node scripts/optimize-realtime-performance.mjs [command]

Commands:
  monitor     Show current realtime performance metrics
  optimize    Run optimization functions
  cleanup     Clean up old realtime data (default: 72h retention)
  analyze     Analyze query performance and show slow queries
  suggest     Show PostgreSQL setting suggestions
  help        Show this help message

Examples:
  node scripts/optimize-realtime-performance.mjs monitor
  node scripts/optimize-realtime-performance.mjs cleanup
  node scripts/optimize-realtime-performance.mjs optimize

Environment Variables Required:
  NEXT_PUBLIC_SUPABASE_URL      - Your Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY     - Your Supabase service role key

For production environments, consider running these optimizations regularly:
  - optimize: every 6 hours
  - cleanup: every 12 hours
  - monitor: as needed for debugging
`);
}

/**
 * Main execution
 */
async function main() {
  const command = process.argv[2] || 'help';
  
  console.log('🔧 Supabase Realtime Performance Optimizer\n');
  
  switch (command.toLowerCase()) {
    case 'monitor':
      await monitorPerformance();
      break;
      
    case 'optimize':
      await runOptimizations();
      break;
      
    case 'cleanup':
      const retentionHours = parseInt(process.argv[3]) || 72;
      await cleanupOldData(retentionHours);
      break;
      
    case 'analyze':
      await analyzeQueries();
      break;
      
    case 'suggest':
      await showSuggestions();
      break;
      
    case 'help':
    default:
      showHelp();
      break;
  }
}

// Run the script
main().catch((error) => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});
