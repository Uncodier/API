# Synced Objects Duplicate Prevention Fix

## Problem Description

The system was responding more than once to the same message between syncs separated by 1 hour. This indicated that the `synced_objects` mechanism was not working correctly to prevent duplicates.

## Root Cause Analysis

### 1. Race Condition in SyncedObjectsService.filterUnprocessedEmails

**Problem**: The logic was checking if an email was "new" based on creation time:

```typescript
// OLD CODE - INCORRECT
const isNewObject = new Date(syncedObject.first_seen_at).getTime() >= (Date.now() - 5000); // Last 5 seconds

if (isNewObject || syncedObject.status === 'pending') {
  // Process email
} else {
  // Skip email
}
```

**Issue**: When syncs are separated by 1 hour, all emails appear as "already processed" because they were created more than 5 seconds ago, even if they have `status: 'pending'`.

### 2. Status Verification Missing in Multiple Services

**Problem**: Several services were only checking if emails exist in `synced_objects`, not their processing status:

- `ComprehensiveEmailFilterService.getProcessedEmails()`
- `ReceivedEmailDuplicationService.filterUnprocessedReceivedEmails()`
- `SentEmailDuplicationService` using `objectExists()`

## Solutions Implemented

### 1. Fixed SyncedObjectsService.filterUnprocessedEmails

**File**: `src/lib/services/synced-objects/SyncedObjectsService.ts`

**Change**: Now only checks the status, not creation time:

```typescript
// NEW CODE - CORRECT
if (syncedObject.status === 'pending') {
  console.log(`[SYNCED_OBJECTS] ✅ Email ${emailId} not processed yet (status: pending), including`);
  unprocessed.push(email);
} else {
  console.log(`[SYNCED_OBJECTS] 🔄 Email ${emailId} already processed (status: ${syncedObject.status}), skipping`);
  alreadyProcessed.push(email);
}
```

### 2. Added objectIsProcessed Method

**File**: `src/lib/services/synced-objects/SyncedObjectsService.ts`

**New Method**: Verifies if an object has been processed (status 'processed' or 'replied'):

```typescript
static async objectIsProcessed(
  externalId: string, 
  siteId: string, 
  objectType: string = this.DEFAULT_OBJECT_TYPE
): Promise<boolean> {
  // Only returns true if object exists AND has status 'processed' or 'replied'
}
```

### 3. Fixed ComprehensiveEmailFilterService

**File**: `src/lib/services/email/ComprehensiveEmailFilterService.ts`

**Change**: Now only considers emails as "processed" if they have status 'processed' or 'replied':

```typescript
const { data: existingObjects, error } = await supabaseAdmin
  .from('synced_objects')
  .select('external_id, status')
  .eq('site_id', siteId)
  .eq('object_type', 'email')
  .in('external_id', envelopeIds)
  .in('status', ['processed', 'replied']); // ONLY truly processed emails
```

### 4. Fixed ReceivedEmailDuplicationService

**File**: `src/lib/services/email/ReceivedEmailDuplicationService.ts`

**Change**: Same fix as ComprehensiveEmailFilterService - only check emails with status 'processed' or 'replied'.

### 5. Fixed SentEmailDuplicationService

**File**: `src/lib/services/email/SentEmailDuplicationService.ts`

**Change**: Now uses `objectIsProcessed()` instead of `objectExists()`:

```typescript
// OLD CODE
const exists = await SyncedObjectsService.objectExists(standardEmailId, siteId, 'sent_email');

// NEW CODE
const isProcessed = await SyncedObjectsService.objectIsProcessed(standardEmailId, siteId, 'sent_email');
```

## Status Flow

The corrected flow now works as follows:

1. **First Sync**: Email is created with `status: 'pending'`
2. **Email Processing**: Email is processed and status changed to `status: 'processed'`
3. **Subsequent Syncs**: Email is correctly identified as already processed and skipped

## Testing

Created test script: `scripts/test-synced-objects-fix.js`

This script verifies:
- Pending emails are correctly identified as unprocessed
- Processed emails are correctly identified as already processed
- The filterUnprocessedEmails logic works correctly
- New emails are properly handled

## Impact

This fix prevents:
- ✅ Duplicate responses to the same email between syncs
- ✅ Unnecessary processing of already handled emails
- ✅ Race conditions in email processing
- ✅ Inconsistent behavior between different sync intervals

## Files Modified

1. `src/lib/services/synced-objects/SyncedObjectsService.ts`
2. `src/lib/services/email/ComprehensiveEmailFilterService.ts`
3. `src/lib/services/email/ReceivedEmailDuplicationService.ts`
4. `src/lib/services/email/SentEmailDuplicationService.ts`
5. `scripts/test-synced-objects-fix.js` (new test file)
6. `SYNCED_OBJECTS_DUPLICATE_FIX.md` (this documentation)

## Verification

To verify the fix works:

1. Run the test script: `node scripts/test-synced-objects-fix.js`
2. Monitor email processing logs for correct status checking
3. Verify no duplicate responses occur between syncs separated by time
