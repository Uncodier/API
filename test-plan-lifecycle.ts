/**
 * Test script for plan lifecycle management
 * Run this to verify that plans are properly completed when new ones are created
 */

import { supabaseAdmin } from './src/lib/database/supabase-client';
import { completeInProgressPlans, getActivePlans } from './src/lib/helpers/plan-lifecycle';

interface TestResult {
  testName: string;
  passed: boolean;
  message: string;
  details?: any;
}

const results: TestResult[] = [];

/**
 * Helper to add test result
 */
function addResult(testName: string, passed: boolean, message: string, details?: any) {
  results.push({ testName, passed, message, details });
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} ${testName}: ${message}`);
  if (details) {
    console.log('   Details:', JSON.stringify(details, null, 2));
  }
}

/**
 * Test 1: Verify database schema has new columns
 */
async function testDatabaseSchema() {
  try {
    const { data, error } = await supabaseAdmin
      .from('instance_plans')
      .select('paused_at, resumed_at, replaced_at, replacement_reason, completion_reason')
      .limit(1);

    if (error) {
      addResult('Database Schema', false, 'New columns not found in database', error);
      return false;
    }

    addResult('Database Schema', true, 'All new columns exist in database');
    return true;
  } catch (error: any) {
    addResult('Database Schema', false, 'Error checking database schema', error.message);
    return false;
  }
}

/**
 * Test 2: Verify paused status is accepted
 */
async function testPausedStatusAccepted() {
  try {
    // Create a test plan
    const { data: testInstance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('id, site_id, user_id')
      .eq('status', 'running')
      .limit(1)
      .single();

    if (instanceError || !testInstance) {
      addResult('Paused Status', false, 'No test instance found', instanceError);
      return false;
    }

    // Insert a test plan
    const { data: testPlan, error: insertError } = await supabaseAdmin
      .from('instance_plans')
      .insert({
        title: 'TEST PLAN - DELETE ME',
        description: 'Temporary test plan for lifecycle testing',
        plan_type: 'task',
        status: 'pending',
        instance_id: testInstance.id,
        site_id: testInstance.site_id,
        user_id: testInstance.user_id
      })
      .select()
      .single();

    if (insertError || !testPlan) {
      addResult('Paused Status', false, 'Failed to create test plan', insertError);
      return false;
    }

    // Try to set it to paused
    const { error: updateError } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'paused',
        paused_at: new Date().toISOString()
      })
      .eq('id', testPlan.id);

    if (updateError) {
      // Clean up
      await supabaseAdmin.from('instance_plans').delete().eq('id', testPlan.id);
      addResult('Paused Status', false, 'Failed to set status to paused', updateError);
      return false;
    }

    // Clean up
    await supabaseAdmin.from('instance_plans').delete().eq('id', testPlan.id);
    
    addResult('Paused Status', true, 'Paused status is accepted by database');
    return true;
  } catch (error: any) {
    addResult('Paused Status', false, 'Error testing paused status', error.message);
    return false;
  }
}

/**
 * Test 3: Verify completeInProgressPlans function works
 */
async function testCompleteInProgressPlans() {
  try {
    // Find an instance with multiple plans
    const { data: instances, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('id, site_id, user_id')
      .limit(5);

    if (instanceError || !instances || instances.length === 0) {
      addResult('Complete Plans Function', false, 'No test instances found', instanceError);
      return false;
    }

    // Create test plans
    const testInstance = instances[0];
    const testPlans = [];

    for (let i = 0; i < 3; i++) {
      const { data: plan, error } = await supabaseAdmin
        .from('instance_plans')
        .insert({
          title: `TEST PLAN ${i} - DELETE ME`,
          description: 'Temporary test plan for lifecycle testing',
          plan_type: 'task',
          status: i === 0 ? 'in_progress' : i === 1 ? 'paused' : 'pending',
          instance_id: testInstance.id,
          site_id: testInstance.site_id,
          user_id: testInstance.user_id
        })
        .select()
        .single();

      if (!error && plan) {
        testPlans.push(plan);
      }
    }

    if (testPlans.length === 0) {
      addResult('Complete Plans Function', false, 'Failed to create test plans');
      return false;
    }

    // Now test the function
    const result = await completeInProgressPlans(testInstance.id);

    // Clean up
    for (const plan of testPlans) {
      await supabaseAdmin.from('instance_plans').delete().eq('id', plan.id);
    }

    if (!result.success) {
      addResult('Complete Plans Function', false, 'Function returned failure', result);
      return false;
    }

    if (result.completedCount !== 3) {
      addResult('Complete Plans Function', false, `Expected 3 completed plans, got ${result.completedCount}`, result);
      return false;
    }

    addResult('Complete Plans Function', true, `Successfully completed ${result.completedCount} plans`, result);
    return true;
  } catch (error: any) {
    addResult('Complete Plans Function', false, 'Error testing function', error.message);
    return false;
  }
}

/**
 * Test 4: Verify getActivePlans function
 */
async function testGetActivePlans() {
  try {
    const { data: instances } = await supabaseAdmin
      .from('remote_instances')
      .select('id')
      .limit(1)
      .single();

    if (!instances) {
      addResult('Get Active Plans', false, 'No test instance found');
      return false;
    }

    const activePlans = await getActivePlans(instances.id);
    
    // This should return an array (even if empty)
    if (!Array.isArray(activePlans)) {
      addResult('Get Active Plans', false, 'Function did not return an array');
      return false;
    }

    addResult('Get Active Plans', true, `Found ${activePlans.length} active plan(s)`);
    return true;
  } catch (error: any) {
    addResult('Get Active Plans', false, 'Error testing function', error.message);
    return false;
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('\n🧪 Starting Plan Lifecycle Tests...\n');

  await testDatabaseSchema();
  await testPausedStatusAccepted();
  await testCompleteInProgressPlans();
  await testGetActivePlans();

  console.log('\n📊 Test Results Summary:\n');
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('\n✅ All tests passed! The plan lifecycle management is working correctly.\n');
  } else {
    console.log('\n❌ Some tests failed. Please review the errors above.\n');
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});

