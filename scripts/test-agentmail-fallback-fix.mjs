/**
 * Test script to verify the AgentMail fallback search fix
 * This script tests that findMessageByDeliveryDetails can find messages
 * regardless of whether recipient is stored in:
 * - custom_data.delivery.to (array or string) - from webhook updates
 * - custom_data.delivery.details.recipient - from initial creation
 * - custom_data.to - fallback location
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Simulates the fixed findMessageByDeliveryDetails function
 */
async function testFindMessageByDeliveryDetails(recipient, timestamp, subject) {
  console.log(`\n🔍 Testing fallback search:`);
  console.log(`   Recipient: ${recipient}`);
  console.log(`   Timestamp: ${timestamp}`);
  console.log(`   Subject: ${subject || 'N/A'}`);

  // Validate timestamp
  const eventTime = new Date(timestamp);
  if (isNaN(eventTime.getTime())) {
    console.error(`❌ Invalid timestamp: "${timestamp}"`);
    return null;
  }

  // Create time window (±5 minutes)
  const timeStart = new Date(eventTime.getTime() - 5 * 60 * 1000).toISOString();
  const timeEnd = new Date(eventTime.getTime() + 5 * 60 * 1000).toISOString();

  console.log(`   Time window: ${timeStart} to ${timeEnd}`);

  // Query messages in time window
  const { data: allMessages, error } = await supabase
    .from('messages')
    .select('id, custom_data, created_at')
    .gte('created_at', timeStart)
    .lte('created_at', timeEnd)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error(`❌ Query error:`, error);
    return null;
  }

  if (!allMessages || allMessages.length === 0) {
    console.log(`⚠️  No messages found in time window`);
    return null;
  }

  console.log(`✅ Found ${allMessages.length} messages in time window`);

  // Filter by recipient (check multiple locations)
  const matchingMessages = allMessages.filter(msg => {
    const customData = msg.custom_data || {};
    
    // Check delivery.to (array or string)
    const deliveryTo = customData.delivery?.to;
    if (deliveryTo) {
      if (Array.isArray(deliveryTo)) {
        if (deliveryTo.includes(recipient)) {
          console.log(`   ✓ Match found via delivery.to (array): ${msg.id}`);
          return true;
        }
      } else if (deliveryTo === recipient) {
        console.log(`   ✓ Match found via delivery.to (string): ${msg.id}`);
        return true;
      }
    }
    
    // Check delivery.details.recipient
    if (customData.delivery?.details?.recipient === recipient) {
      console.log(`   ✓ Match found via delivery.details.recipient: ${msg.id}`);
      return true;
    }
    
    // Check top-level to
    const topLevelTo = customData.to;
    if (topLevelTo) {
      if (Array.isArray(topLevelTo)) {
        if (topLevelTo.includes(recipient)) {
          console.log(`   ✓ Match found via top-level to (array): ${msg.id}`);
          return true;
        }
      } else if (topLevelTo === recipient) {
        console.log(`   ✓ Match found via top-level to (string): ${msg.id}`);
        return true;
      }
    }
    
    return false;
  });

  if (matchingMessages.length === 0) {
    console.log(`⚠️  No messages matching recipient: ${recipient}`);
    return null;
  }

  console.log(`✅ Found ${matchingMessages.length} message(s) matching recipient`);

  // If subject provided, match it
  if (subject) {
    const matchedMessage = matchingMessages.find(msg => 
      msg.custom_data?.subject === subject ||
      msg.custom_data?.delivery?.subject === subject ||
      msg.custom_data?.delivery?.details?.subject === subject
    );
    
    if (matchedMessage) {
      console.log(`✅ Found message by subject match: ${matchedMessage.id}`);
      return matchedMessage;
    }
    
    console.warn(`⚠️  Subject provided but no match found`);
    return null;
  }

  // Return most recent
  console.log(`✅ Returning most recent message: ${matchingMessages[0].id}`);
  return matchingMessages[0];
}

/**
 * Main test function
 */
async function runTests() {
  console.log('🧪 Testing AgentMail Fallback Search Fix\n');
  console.log('=' .repeat(60));

  // Test 1: Find a recent assistant message
  console.log('\n📋 Test 1: Finding recent assistant messages');
  const { data: recentMessages, error: recentError } = await supabase
    .from('messages')
    .select('id, custom_data, created_at, role')
    .eq('role', 'assistant')
    .not('custom_data->delivery', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5);

  if (recentError || !recentMessages || recentMessages.length === 0) {
    console.log('⚠️  No recent assistant messages with delivery data found');
    console.log('   This is expected if no emails have been sent recently');
    return;
  }

  console.log(`✅ Found ${recentMessages.length} recent assistant messages with delivery data\n`);

  // Analyze structure of found messages
  console.log('📊 Analyzing message structures:');
  recentMessages.forEach((msg, idx) => {
    console.log(`\n   Message ${idx + 1}: ${msg.id}`);
    console.log(`   Created: ${msg.created_at}`);
    
    const customData = msg.custom_data || {};
    
    // Check where recipient data is stored
    const locations = [];
    if (customData.delivery?.to) {
      locations.push(`delivery.to (${Array.isArray(customData.delivery.to) ? 'array' : 'string'})`);
    }
    if (customData.delivery?.details?.recipient) {
      locations.push('delivery.details.recipient');
    }
    if (customData.to) {
      locations.push(`to (${Array.isArray(customData.to) ? 'array' : 'string'})`);
    }
    
    console.log(`   Recipient locations: ${locations.length > 0 ? locations.join(', ') : 'NONE FOUND ⚠️'}`);
    
    // Extract recipient for testing
    let recipient = null;
    if (customData.delivery?.to) {
      recipient = Array.isArray(customData.delivery.to) 
        ? customData.delivery.to[0] 
        : customData.delivery.to;
    } else if (customData.delivery?.details?.recipient) {
      recipient = customData.delivery.details.recipient;
    } else if (customData.to) {
      recipient = Array.isArray(customData.to) ? customData.to[0] : customData.to;
    }
    
    if (recipient) {
      console.log(`   Recipient: ${recipient}`);
    } else {
      console.log(`   ⚠️  Could not extract recipient`);
    }
  });

  // Test with the first message
  if (recentMessages.length > 0) {
    const testMsg = recentMessages[0];
    const customData = testMsg.custom_data || {};
    
    // Extract recipient
    let recipient = null;
    if (customData.delivery?.to) {
      recipient = Array.isArray(customData.delivery.to) 
        ? customData.delivery.to[0] 
        : customData.delivery.to;
    } else if (customData.delivery?.details?.recipient) {
      recipient = customData.delivery.details.recipient;
    } else if (customData.to) {
      recipient = Array.isArray(customData.to) ? customData.to[0] : customData.to;
    }
    
    if (recipient) {
      console.log('\n' + '='.repeat(60));
      console.log('📋 Test 2: Testing fallback search with real message');
      
      const result = await testFindMessageByDeliveryDetails(
        recipient,
        testMsg.created_at,
        customData.subject || customData.delivery?.subject || customData.delivery?.details?.subject
      );
      
      if (result && result.id === testMsg.id) {
        console.log('\n✅ SUCCESS: Fallback search correctly found the message!');
      } else if (result) {
        console.log(`\n⚠️  PARTIAL: Found a message (${result.id}) but not the expected one (${testMsg.id})`);
      } else {
        console.log('\n❌ FAILURE: Fallback search did not find the message');
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Test completed\n');
}

// Run tests
runTests().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

