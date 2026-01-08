# AgentMail Timestamp Validation Fix

## Issue

The `findMessageByDeliveryDetails` function in `src/lib/integrations/agentmail/message-updater.ts` was creating a Date object from the `timestamp` parameter without validation. This created a potential crash scenario:

1. If `timestamp` is an invalid date string (e.g., malformed webhook payload)
2. `new Date(timestamp)` creates an Invalid Date
3. Calling `.getTime()` returns `NaN`
4. `new Date(NaN - 5 * 60 * 1000)` is also Invalid Date
5. Calling `.toISOString()` throws `RangeError: Invalid time value`

## Solution

Added timestamp validation before using the date:

```typescript
// Validate timestamp before using it
const eventTime = new Date(timestamp);
if (isNaN(eventTime.getTime())) {
  console.error(`[AgentMail] ❌ Invalid timestamp provided: "${timestamp}" - Cannot perform fallback search`);
  return null;
}
```

## Impact

- **Before**: Invalid timestamps would crash the webhook handler with an uncaught exception
- **After**: Invalid timestamps are caught early, logged for debugging, and gracefully return null

## Benefits

1. **Robustness**: Webhook handlers won't crash on malformed payloads
2. **Observability**: Invalid timestamps are logged with clear error messages
3. **Graceful degradation**: Function returns null instead of crashing, allowing error handling at higher levels

## Testing

A comprehensive test suite was created at `src/__tests__/lib/integrations/agentmail/message-updater.test.ts` that verifies:

- Valid ISO timestamps work correctly
- Invalid timestamps return null without throwing
- Empty timestamps are handled gracefully
- Malformed ISO timestamps don't crash
- Numeric timestamp strings work correctly

## Affected Webhook Handlers

This fix protects all AgentMail webhook handlers that use the fallback search mechanism:

- `message-bounced` webhook
- `message-rejected` webhook
- `message-complained` webhook
- `message-sent` webhook
- `message-delivered` webhook

All of these handlers call `findMessageWithFallback`, which internally uses `findMessageByDeliveryDetails` when the primary search fails.

## Date: January 7, 2026

