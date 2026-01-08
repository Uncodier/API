# AgentMail Fallback Search Fix

## Problem

The `findMessageByDeliveryDetails` function in `src/lib/integrations/agentmail/message-updater.ts` was querying the wrong field path to find messages by recipient, causing the fallback mechanism to always fail.

### Root Cause

There was a mismatch between:
1. **What was stored**: Multiple possible locations for recipient data
2. **What was queried**: Only `custom_data->delivery->details->>recipient`

### Data Structure Evolution

When messages are created and updated, recipient data can be stored in different locations:

#### Initial Message Creation (via AgentMail API)
```json
{
  "custom_data": {
    "delivery": {
      "details": {
        "recipient": "user@example.com"  // ✓ String format
      }
    }
  }
}
```

#### After Webhook Updates
```json
{
  "custom_data": {
    "delivery": {
      "to": ["user@example.com"],  // ✓ Array format (from eventMetadata)
      "details": {
        "recipient": "user@example.com"
      }
    }
  }
}
```

#### Alternative Formats
```json
{
  "custom_data": {
    "to": "user@example.com",  // ✓ Top-level fallback
    "delivery": { ... }
  }
}
```

### The Bug

The original query used a PostgreSQL JSON path filter:
```javascript
.filter('custom_data->delivery->details->>recipient', 'eq', recipient)
```

**Problem**: This only works for the initial creation format. After webhook updates spread `eventMetadata` into `delivery`, the `to` field is added at `custom_data->delivery->to`, which the query doesn't check.

**Impact**: 
- Fallback search always returned null
- Webhook events failed to find messages when `agentmail_message_id` was "unknown"
- Messages couldn't be updated with delivery status

## Solution

### Changes Made

Modified `findMessageByDeliveryDetails` to:

1. **Query broadly**: Fetch all messages in the time window without recipient filter
2. **Filter in-memory**: Check multiple possible locations for recipient data
3. **Handle multiple formats**: Support both array and string formats

### Implementation

```typescript
// Query all messages in time window
const { data: allMessages, error } = await supabaseAdmin
  .from('messages')
  .select('id, custom_data, created_at')
  .gte('created_at', timeStart)
  .lte('created_at', timeEnd)
  .eq('role', 'assistant')
  .order('created_at', { ascending: false })
  .limit(50);

// Filter in-memory checking multiple locations
const matchingMessages = allMessages.filter(msg => {
  const customData = msg.custom_data || {};
  
  // Check 1: custom_data.delivery.to (array or string)
  const deliveryTo = customData.delivery?.to;
  if (deliveryTo) {
    if (Array.isArray(deliveryTo) && deliveryTo.includes(recipient)) return true;
    if (deliveryTo === recipient) return true;
  }
  
  // Check 2: custom_data.delivery.details.recipient (string)
  if (customData.delivery?.details?.recipient === recipient) return true;
  
  // Check 3: custom_data.to (array or string, fallback)
  const topLevelTo = customData.to;
  if (topLevelTo) {
    if (Array.isArray(topLevelTo) && topLevelTo.includes(recipient)) return true;
    if (topLevelTo === recipient) return true;
  }
  
  return false;
});
```

### Why In-Memory Filtering?

PostgreSQL JSON path operators have limitations:
- Can't easily check multiple paths in a single query
- Can't handle "array OR string" type variations
- Complex OR conditions across nested paths are verbose and error-prone

In-memory filtering is:
- ✅ More flexible (handles any data structure)
- ✅ More maintainable (clear logic)
- ✅ Still performant (limited to 50 messages in 10-minute window)
- ✅ Future-proof (works with new storage patterns)

## Testing

### Test Script

Created `scripts/test-agentmail-fallback-fix.mjs` to verify the fix with real database data.

### Test Results

```
✅ Found 5 recent assistant messages with delivery data
✅ All messages correctly identified recipient location
✅ Fallback search successfully found message by recipient
✅ SUCCESS: Fallback search correctly found the message!
```

### Unit Tests

Created comprehensive unit tests in `src/__tests__/lib/agentmail-message-updater.test.ts`:
- ✅ Find message with `delivery.to` as array
- ✅ Find message with `delivery.to` as string
- ✅ Find message with `delivery.details.recipient`
- ✅ Find message with top-level `to` field
- ✅ Match by subject when provided
- ✅ Return null when subject doesn't match
- ✅ Return null when recipient doesn't match
- ✅ Handle invalid timestamps
- ✅ Return most recent message when no subject
- ✅ Check multiple subject locations

## Impact

### Before Fix
- ❌ Fallback search always returned null
- ❌ Webhook events failed for messages with "unknown" message_id
- ❌ Messages couldn't be updated with delivery status
- ❌ Logs showed: "Message not found" even when message existed

### After Fix
- ✅ Fallback search finds messages regardless of storage format
- ✅ Webhook events succeed even with "unknown" message_id
- ✅ Messages correctly updated with delivery status
- ✅ Backfills `agentmail_message_id` when found via fallback

## Files Modified

1. **src/lib/integrations/agentmail/message-updater.ts**
   - Fixed `findMessageByDeliveryDetails` to check multiple recipient locations
   - Added in-memory filtering for flexibility
   - Improved logging for debugging

2. **src/__tests__/lib/agentmail-message-updater.test.ts** (new)
   - Comprehensive unit tests for all scenarios

3. **scripts/test-agentmail-fallback-fix.mjs** (new)
   - Integration test with real database data

4. **docs/AGENTMAIL_FALLBACK_SEARCH_FIX.md** (this file)
   - Documentation of the issue and fix

## Related Code

The fallback mechanism is used in all webhook handlers:
- `src/app/api/integrations/agentmail/webhook/message-sent/route.ts`
- `src/app/api/integrations/agentmail/webhook/message-delivered/route.ts`
- `src/app/api/integrations/agentmail/webhook/message-bounced/route.ts`
- `src/app/api/integrations/agentmail/webhook/message-rejected/route.ts`
- `src/app/api/integrations/agentmail/webhook/message-complained/route.ts`

All these handlers now benefit from the fixed fallback search.

## Future Considerations

### Data Structure Standardization

Consider standardizing where recipient data is stored:

**Option 1**: Always use `custom_data.delivery.to` (array)
- Pros: Single source of truth, consistent format
- Cons: Requires migration of existing messages

**Option 2**: Keep current flexible approach
- Pros: Backward compatible, handles all formats
- Cons: Multiple locations to check

**Recommendation**: Keep current flexible approach. The in-memory filtering handles all cases efficiently and is future-proof.

### Performance Optimization

Current approach queries up to 50 messages in a 10-minute window. This is efficient for typical use cases. If performance becomes an issue:

1. Add database index on `created_at` and `role` (likely already exists)
2. Reduce time window from ±5 minutes to ±2 minutes
3. Add caching layer for recent lookups

### Monitoring

Add metrics to track:
- Fallback search success rate
- Time taken for fallback searches
- Most common recipient storage locations

This will help identify if further optimization is needed.

## Conclusion

The fix ensures the AgentMail webhook integration works reliably by:
1. Correctly finding messages regardless of data structure variations
2. Supporting multiple storage formats for recipient data
3. Providing a robust fallback mechanism when message_id is unavailable
4. Maintaining backward compatibility with existing messages

The solution is flexible, maintainable, and future-proof.

