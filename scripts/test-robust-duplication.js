/**
 * Test script for robust duplication detection
 * This script tests the new EmailDuplicationService that uses the same logic as email/sync
 */

import { EmailDuplicationService } from '../src/lib/services/email/EmailDuplicationService.js';
import { supabaseAdmin } from '../src/lib/database/supabase-client.js';

const TEST_CONVERSATION_ID = 'test-conversation-123';
const TEST_LEAD_ID = 'test-lead-123';
const TEST_SITE_ID = 'test-site-123';

async function testRobustDuplicationDetection() {
  console.log('🧪 Testing robust duplication detection...\n');

  try {
    // Clean up any existing test data
    await cleanupTestData();

    // Test 1: Create a test message in the conversation
    console.log('📝 Test 1: Creating test message in conversation...');
    const testMessage = await createTestMessage();
    console.log('✅ Test message created:', testMessage.id);

    // Test 2: Test exact ID match
    console.log('\n📝 Test 2: Testing exact ID match...');
    const testEmail1 = {
      subject: 'Test Email',
      to: 'test@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString(),
      messageId: 'test-message-id-123'
    };

    const result1 = await EmailDuplicationService.checkEmailDuplication(
      testEmail1,
      TEST_CONVERSATION_ID,
      TEST_LEAD_ID,
      TEST_SITE_ID
    );

    console.log('Result 1:', result1);
    console.log('Expected: isDuplicate = true (exact ID match)');

    // Test 3: Test exact subject + recipient + timestamp match
    console.log('\n📝 Test 3: Testing exact subject + recipient + timestamp match...');
    const testEmail2 = {
      subject: 'Test Email',
      to: 'test@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString(),
      messageId: 'different-message-id'
    };

    const result2 = await EmailDuplicationService.checkEmailDuplication(
      testEmail2,
      TEST_CONVERSATION_ID,
      TEST_LEAD_ID,
      TEST_SITE_ID
    );

    console.log('Result 2:', result2);
    console.log('Expected: isDuplicate = true (exact subject + recipient + timestamp)');

    // Test 4: Test new email (should not be duplicate)
    console.log('\n📝 Test 4: Testing new email...');
    const testEmail3 = {
      subject: 'Different Subject',
      to: 'different@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString(),
      messageId: 'new-message-id'
    };

    const result3 = await EmailDuplicationService.checkEmailDuplication(
      testEmail3,
      TEST_CONVERSATION_ID,
      TEST_LEAD_ID,
      TEST_SITE_ID
    );

    console.log('Result 3:', result3);
    console.log('Expected: isDuplicate = false (new email)');

    // Test 5: Test recipient + temporal proximity
    console.log('\n📝 Test 5: Testing recipient + temporal proximity...');
    const testEmail4 = {
      subject: 'Another Subject',
      to: 'test@example.com', // Same recipient as test message
      from: 'sender@example.com',
      date: new Date().toISOString(), // Very close in time
      messageId: 'proximity-test-id'
    };

    const result4 = await EmailDuplicationService.checkEmailDuplication(
      testEmail4,
      TEST_CONVERSATION_ID,
      TEST_LEAD_ID,
      TEST_SITE_ID
    );

    console.log('Result 4:', result4);
    console.log('Expected: isDuplicate = true (recipient + temporal proximity)');

    console.log('\n🎯 All tests completed. Check results above.');

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await cleanupTestData();
  }
}

async function createTestMessage() {
  const messageData = {
    conversation_id: TEST_CONVERSATION_ID,
    content: 'Test message content',
    role: 'assistant',
    user_id: 'test-user',
    lead_id: TEST_LEAD_ID,
    custom_data: {
      status: 'sent',
      delivery: {
        channel: 'email',
        details: {
          channel: 'email',
          recipient: 'test@example.com',
          subject: 'Test Email',
          timestamp: new Date().toISOString(),
          api_messageId: 'test-message-id-123'
        },
        success: true,
        timestamp: new Date().toISOString()
      },
      email_id: 'test-message-id-123'
    }
  };

  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert([messageData])
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create test message: ${error.message}`);
  }

  return data;
}

async function cleanupTestData() {
  try {
    const { error } = await supabaseAdmin
      .from('messages')
      .delete()
      .eq('conversation_id', TEST_CONVERSATION_ID);
    
    if (error) {
      console.warn('⚠️ Cleanup warning:', error);
    } else {
      console.log('🧹 Test data cleaned up');
    }
  } catch (error) {
    console.warn('⚠️ Cleanup error:', error);
  }
}

// Run the test
testRobustDuplicationDetection().catch(console.error);
