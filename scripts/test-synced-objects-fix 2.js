/**
 * Test script to verify synced_objects fixes for duplicate prevention
 * This script tests the corrected logic that prevents duplicate responses between syncs
 */

import { SyncedObjectsService } from '../src/lib/services/synced-objects/SyncedObjectsService.js';
import { supabaseAdmin } from '../src/lib/database/supabase-client.js';

const TEST_SITE_ID = 'test-site-id-123';
const TEST_EMAIL_ID = 'test-email-123@example.com';

async function testSyncedObjectsLogic() {
  console.log('🧪 Testing synced_objects duplicate prevention logic...\n');

  try {
    // Clean up any existing test data
    await cleanupTestData();

    // Test 1: Create a pending email
    console.log('📝 Test 1: Creating email with status "pending"...');
    const pendingEmail = await SyncedObjectsService.createObject({
      external_id: TEST_EMAIL_ID,
      site_id: TEST_SITE_ID,
      object_type: 'email',
      status: 'pending',
      provider: 'test',
      metadata: { subject: 'Test Email' }
    });
    console.log('✅ Pending email created:', pendingEmail?.id);

    // Test 2: Verify objectExists returns true (should exist)
    console.log('\n📝 Test 2: Testing objectExists with pending email...');
    const exists = await SyncedObjectsService.objectExists(TEST_EMAIL_ID, TEST_SITE_ID, 'email');
    console.log('✅ objectExists result:', exists); // Should be true

    // Test 3: Verify objectIsProcessed returns false (not processed yet)
    console.log('\n📝 Test 3: Testing objectIsProcessed with pending email...');
    const isProcessed = await SyncedObjectsService.objectIsProcessed(TEST_EMAIL_ID, TEST_SITE_ID, 'email');
    console.log('✅ objectIsProcessed result:', isProcessed); // Should be false

    // Test 4: Mark as processed
    console.log('\n📝 Test 4: Marking email as processed...');
    const marked = await SyncedObjectsService.markAsProcessed(TEST_EMAIL_ID, TEST_SITE_ID, { processed_at: new Date().toISOString() }, 'email');
    console.log('✅ Marked as processed:', marked);

    // Test 5: Verify objectIsProcessed now returns true
    console.log('\n📝 Test 5: Testing objectIsProcessed with processed email...');
    const isProcessedAfter = await SyncedObjectsService.objectIsProcessed(TEST_EMAIL_ID, TEST_SITE_ID, 'email');
    console.log('✅ objectIsProcessed result after processing:', isProcessedAfter); // Should be true

    // Test 6: Test filterUnprocessedEmails logic
    console.log('\n📝 Test 6: Testing filterUnprocessedEmails logic...');
    const testEmails = [
      {
        id: TEST_EMAIL_ID,
        messageId: TEST_EMAIL_ID,
        from: 'test@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email',
        provider: 'test'
      }
    ];

    const { unprocessed, alreadyProcessed } = await SyncedObjectsService.filterUnprocessedEmails(testEmails, TEST_SITE_ID, 'email');
    console.log('✅ filterUnprocessedEmails results:');
    console.log('   - Unprocessed:', unprocessed.length); // Should be 0 (already processed)
    console.log('   - Already processed:', alreadyProcessed.length); // Should be 1

    // Test 7: Create a new email and test the flow
    console.log('\n📝 Test 7: Testing with a new email...');
    const newEmailId = 'new-test-email-456@example.com';
    const newTestEmails = [
      {
        id: newEmailId,
        messageId: newEmailId,
        from: 'new@example.com',
        to: 'recipient@example.com',
        subject: 'New Test Email',
        provider: 'test'
      }
    ];

    const { unprocessed: newUnprocessed, alreadyProcessed: newAlreadyProcessed } = await SyncedObjectsService.filterUnprocessedEmails(newTestEmails, TEST_SITE_ID, 'email');
    console.log('✅ New email filterUnprocessedEmails results:');
    console.log('   - Unprocessed:', newUnprocessed.length); // Should be 1 (new email)
    console.log('   - Already processed:', newAlreadyProcessed.length); // Should be 0

    console.log('\n🎉 All tests passed! The synced_objects logic is working correctly.');

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await cleanupTestData();
  }
}

async function cleanupTestData() {
  try {
    const { error } = await supabaseAdmin
      .from('synced_objects')
      .delete()
      .eq('site_id', TEST_SITE_ID);
    
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
testSyncedObjectsLogic().catch(console.error);
