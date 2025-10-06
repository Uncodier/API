# Plan Lifecycle Management Fix - Summary

## Problem Statement

When creating a new robot plan, existing plans (with status `in_progress`, `active`, `pending`, or `paused`) were not being properly completed. This resulted in multiple active plans coexisting in the database for the same instance, causing confusion and unexpected behavior.

## Root Causes Identified

1. **Missing Error Handling**: The `completeInProgressPlans` function did not check if database updates were successful, logging success even when updates failed.

2. **Code Duplication**: The function was duplicated across multiple files with identical implementations, making maintenance difficult.

3. **Incomplete Coverage**: The `/api/robots/plan/initiate` route was missing the call to complete previous plans.

4. **Database Constraint**: The `instance_plans` table did not include `paused` and `replaced` as valid status values in the CHECK constraint.

## Solution Implemented

### 1. Database Migration

**File**: `supabase/migrations/20250106000000_add_paused_status_to_instance_plans.sql`

- Added `paused` and `replaced` as valid status values
- Added new tracking columns:
  - `paused_at`: Timestamp when plan was paused
  - `resumed_at`: Timestamp when plan was resumed
  - `replaced_at`: Timestamp when plan was replaced
  - `replacement_reason`: Reason for replacement
  - `completion_reason`: Reason for completion
- Added indexes for better query performance

### 2. Centralized Lifecycle Management

**File**: `src/lib/helpers/plan-lifecycle.ts`

Created a new centralized module with proper error handling:

- `completeInProgressPlans(instanceId, completionReason?)`: Complete all active plans
  - Returns `CompletePlanResult` with success status, count, and errors
  - Properly checks for update errors
  - Logs accurate results

- `replacePlan(planId, replacementReason?)`: Mark a plan as replaced

- `pausePlan(planId)`: Pause a plan

- `resumePlan(planId)`: Resume a paused plan

- `getActivePlans(instanceId)`: Get all active plans for an instance

### 3. Updated All Plan Creation Points

Updated the following files to use the centralized function:

1. **`src/app/api/agents/growth/robot/plan/route.ts`**
   - Removed local `completeInProgressPlans` function
   - Imported from `@/lib/helpers/plan-lifecycle`

2. **`src/app/api/robots/instance/act/route.ts`**
   - Removed local `completeInProgressPlans` function
   - Imported from `@/lib/helpers/plan-lifecycle`

3. **`src/lib/services/robot-instance/robot-plan-service.ts`**
   - Removed local `completeInProgressPlans` function
   - Imported from `@/lib/helpers/plan-lifecycle`

4. **`src/lib/services/robot-plan-execution/plan-manager.ts`**
   - Removed local `completeInProgressPlans` function
   - Imported from `@/lib/helpers/plan-lifecycle`
   - Also uses `replacePlan` function

5. **`src/app/api/robots/plan/initiate/route.ts`** ⚠️ **NEW**
   - Added call to `completeInProgressPlans` before initiating a new plan
   - This was previously missing!

## Benefits

1. **Proper Error Handling**: All plan completion operations now check for errors and report them accurately.

2. **Single Source of Truth**: One centralized implementation makes maintenance easier and reduces bugs.

3. **Better Tracking**: New database columns provide audit trail for plan lifecycle events.

4. **Complete Coverage**: All plan creation endpoints now properly handle existing plans.

5. **Enhanced Status Support**: Full support for `paused` and `replaced` statuses.

## Testing Instructions

### 1. Run the Database Migration

```bash
# Apply the migration to your database
npx supabase migration up
```

### 2. Test Plan Creation Flow

```typescript
// Test creating a new plan when an active plan exists
// Before: Both plans would remain active
// After: Old plan should be marked as 'completed'

// 1. Create first plan
POST /api/agents/growth/robot/plan
{
  "site_id": "...",
  "user_id": "...",
  "instance_id": "...",
  "activity": "test activity 1"
}

// 2. Check database - should have 1 plan with status 'pending'
SELECT * FROM instance_plans WHERE instance_id = '...';

// 3. Create second plan
POST /api/agents/growth/robot/plan
{
  "site_id": "...",
  "user_id": "...",
  "instance_id": "...",
  "activity": "test activity 2"
}

// 4. Check database again
SELECT * FROM instance_plans WHERE instance_id = '...' ORDER BY created_at DESC;
// Expected: First plan has status 'completed' with completion_reason
//           Second plan has status 'pending'
```

### 3. Test Paused Plan Handling

```typescript
// Test that paused plans are properly completed

// 1. Create a plan and mark it as paused
POST /api/agents/growth/robot/plan
// ... then manually update status to 'paused'
UPDATE instance_plans SET status = 'paused', paused_at = NOW() WHERE id = '...';

// 2. Create a new plan
POST /api/agents/growth/robot/plan
// ... (same instance_id)

// 3. Verify the paused plan is now completed
SELECT * FROM instance_plans WHERE id = '...';
// Expected: status = 'completed', completion_reason set
```

### 4. Test Plan Initiation

```typescript
// Test that initiating a plan completes previous plans

// 1. Create multiple plans for an instance
// 2. Initiate one of them
POST /api/robots/plan/initiate
{
  "instance_plan_id": "..."
}

// 3. Verify other active plans are completed
SELECT * FROM instance_plans WHERE instance_id = '...' AND status NOT IN ('completed', 'replaced');
// Expected: Only the initiated plan should be active
```

### 5. Monitor Logs

Look for these log messages to verify proper operation:

```
₍ᐢ•(ܫ)•ᐢ₎ Checking for active plans to complete for instance: <id>
₍ᐢ•(ܫ)•ᐢ₎ Found X active plan(s) to complete
₍ᐢ•(ܫ)•ᐢ₎ ✅ Plan <id> marked as completed (was <previous_status>)
₍ᐢ•(ܫ)•ᐢ₎ ✅ Successfully completed all X active plan(s)
```

Or for errors:
```
₍ᐢ•(ܫ)•ᐢ₎ ❌ Failed to complete plan <id>: <error_message>
₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Completed X/Y plans with Z error(s)
```

## Database Schema Changes

### New Status Values
- `paused`: Plan is temporarily paused
- `replaced`: Plan was replaced by a new plan

### New Columns
- `paused_at TIMESTAMP`: When the plan was paused
- `resumed_at TIMESTAMP`: When the plan was resumed
- `replaced_at TIMESTAMP`: When the plan was replaced
- `replacement_reason TEXT`: Why the plan was replaced
- `completion_reason TEXT`: Why the plan was completed

### New Indexes
- `idx_instance_plans_status`: Faster status queries
- `idx_instance_plans_instance_status`: Faster instance+status queries

## Files Modified

1. **New Files**:
   - `supabase/migrations/20250106000000_add_paused_status_to_instance_plans.sql`
   - `src/lib/helpers/plan-lifecycle.ts`
   - `PLAN_LIFECYCLE_FIX_SUMMARY.md` (this file)

2. **Modified Files**:
   - `src/app/api/agents/growth/robot/plan/route.ts`
   - `src/app/api/robots/instance/act/route.ts`
   - `src/lib/services/robot-instance/robot-plan-service.ts`
   - `src/lib/services/robot-plan-execution/plan-manager.ts`
   - `src/app/api/robots/plan/initiate/route.ts`

## Backward Compatibility

✅ **Fully backward compatible**

- Existing plans with old statuses continue to work
- New columns are nullable
- The migration only adds, doesn't remove or modify existing data
- Old behavior is preserved, but now with proper error handling

## Next Steps

1. **Apply the migration** to your development database
2. **Test the scenarios** outlined above
3. **Monitor logs** in production for any errors
4. **Update documentation** to reflect the new pause/resume functionality

## Additional Notes

- All existing code calling `completeInProgressPlans` will benefit from the improved error handling
- The function signature remains the same for backward compatibility
- Optional `completionReason` parameter allows for more detailed audit trails
- The new `getActivePlans` utility function can be used for debugging and monitoring

