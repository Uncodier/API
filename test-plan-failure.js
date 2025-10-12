/**
 * Test script to verify plan failure functionality
 * Tests the markRunningPlansAsFailed function
 */

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing Supabase environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function testPlanFailure() {
  console.log('🧪 Testing plan failure functionality...\n');

  try {
    // 1. Find an instance with running plans
    console.log('1. Looking for instances with running plans...');
    const { data: runningPlans, error: fetchError } = await supabase
      .from('instance_plans')
      .select('instance_id, id, title, status')
      .in('status', ['in_progress', 'paused'])
      .limit(5);

    if (fetchError) {
      console.error('❌ Error fetching running plans:', fetchError);
      return;
    }

    if (!runningPlans || runningPlans.length === 0) {
      console.log('ℹ️ No running plans found to test with');
      return;
    }

    console.log(`✅ Found ${runningPlans.length} running plan(s):`);
    runningPlans.forEach(plan => {
      console.log(`   - Plan ${plan.id}: "${plan.title}" (${plan.status})`);
    });

    // 2. Test the markRunningPlansAsFailed function
    console.log('\n2. Testing markRunningPlansAsFailed function...');
    
    // Import the function (simulate the import)
    const { markRunningPlansAsFailed } = require('./src/lib/helpers/plan-lifecycle.ts');
    
    // Test with the first instance that has running plans
    const testInstanceId = runningPlans[0].instance_id;
    console.log(`Testing with instance: ${testInstanceId}`);

    const result = await markRunningPlansAsFailed(
      testInstanceId,
      'Test: Instance was stopped while plan was running'
    );

    console.log('\n📊 Test Results:');
    console.log(`   Success: ${result.success}`);
    console.log(`   Plans marked as failed: ${result.completedCount}`);
    console.log(`   Errors: ${result.errors.length}`);
    
    if (result.errors.length > 0) {
      console.log('   Error details:');
      result.errors.forEach(error => console.log(`     - ${error}`));
    }

    // 3. Verify the plans were actually marked as failed
    console.log('\n3. Verifying plans were marked as failed...');
    const { data: updatedPlans, error: verifyError } = await supabase
      .from('instance_plans')
      .select('id, title, status, error_message')
      .eq('instance_id', testInstanceId)
      .eq('status', 'failed')
      .order('updated_at', { ascending: false });

    if (verifyError) {
      console.error('❌ Error verifying updated plans:', verifyError);
      return;
    }

    console.log(`✅ Found ${updatedPlans?.length || 0} failed plan(s):`);
    updatedPlans?.forEach(plan => {
      console.log(`   - Plan ${plan.id}: "${plan.title}"`);
      console.log(`     Error: ${plan.error_message}`);
    });

    console.log('\n🎉 Test completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testPlanFailure().then(() => {
  console.log('\n✨ Test script finished');
  process.exit(0);
}).catch(error => {
  console.error('❌ Test script failed:', error);
  process.exit(1);
});
