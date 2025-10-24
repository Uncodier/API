# Rate Limit Error Handling Implementation

## Overview

This document describes the implementation of rate limit error handling for the agent processor system. When the agent processor receives a 429 rate limit error from the LLM API, it now properly handles the error and provides appropriate retry logic.

## Problem Statement

When the agent processor receives a response like this:

```json
{
  "status": 429,
  "headers": {
    "cache-control": "public, max-age=0, must-revalidate",
    "cf-cache-status": "DYNAMIC",
    "cf-ray": "976911f111b6c9b3-IAD",
    "connection": "keep-alive",
    "content-type": "application/json",
    "date": "Fri, 29 Aug 2025 03:48:00 GMT",
    "server": "cloudflare",
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "transfer-encoding": "chunked",
    "x-matched-path": "/v1/chat/completions",
    "x-portkey-cache-status": "MISS",
    "x-portkey-last-used-option-index": "config",
    "x-portkey-provider": "openai",
    "x-portkey-retry-attempt-count": "-1",
    "x-portkey-trace-id": "fe7cd013-3699-46db-a656-03cbbff57eec",
    "x-vercel-cache": "MISS",
    "x-vercel-id": "iad1::iad1::hxph7-1756439278280-f267924ec33e"
  },
  "body": {
    "error": {
      "message": "openai error: Requests to the ChatCompletions_Create Operation under OpenAI Language Model Instance API have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 60 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit. For Free Account customers, upgrade to Pay as you Go here: https://aka.ms/429TrialUpgrade.",
      "type": "AI_APICallError",
      "param": {
        "error": "Requests to the ChatCompletions_Create Operation under OpenAI Language Model Instance API have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 60 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit. For Free Account customers, upgrade to Pay as you Go here: https://aka.ms/429TrialUpgrade.",
        "statusCode": 429,
        "name": "AI_APICallError",
        "message": "Requests to the ChatCompletions_Create Operation under OpenAI Language Model Instance API have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 60 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit. For Free Account customers, upgrade to Pay as you Go here: https://aka.ms/429TrialUpgrade.",
        "url": "https://ai-gateway-resource.openai.azure.com/openai/v1/chat/completions?api-version=preview",
        "isRetryable": true,
        "type": "AI_APICallError"
      },
      "code": null
    },
    "provider": "openai"
  },
  "responseTime": 44363,
  "lastUsedOptionJsonPath": "config"
}
```

The system should:
1. Detect the rate limit error
2. Retry the request after waiting 60 seconds (as suggested by the API)
3. If all retries fail, fail the command gracefully with a proper error message

## Implementation Details

### 1. PortkeyConnector.ts

**Enhanced retry logic with rate limit detection:**

```typescript
// Check if it's a 429 rate limit error
const isRateLimitError = retryError.status === 429 || 
                       retryError.message?.includes('rate limit') ||
                       retryError.message?.includes('exceeded token rate limit') ||
                       retryError.message?.includes('AIServices S0 pricing tier');

// Calculate wait time based on error type
let waitTime;
if (isRateLimitError) {
  // For rate limit errors, wait longer (60 seconds as suggested in the error message)
  waitTime = 60 * 1000; // 60 seconds
  console.log(`[PortkeyConnector] Rate limit error detected, waiting ${waitTime/1000}s as suggested by API...`);
} else {
  // For other retryable errors, use exponential backoff
  waitTime = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
  console.log(`[PortkeyConnector] Esperando ${waitTime}ms antes del siguiente intento...`);
}
```

**Enhanced error detection for nested error structures:**

```typescript
// Check if it's a 429 rate limit error from the response structure
const isRateLimitError = apiCallError.status === 429 || 
                       apiCallError.body?.error?.message?.includes('exceeded token rate limit') ||
                       apiCallError.body?.error?.message?.includes('AIServices S0 pricing tier') ||
                       apiCallError.body?.error?.param?.error?.includes('exceeded token rate limit') ||
                       apiCallError.body?.error?.param?.error?.includes('AIServices S0 pricing tier') ||
                       apiCallError.message?.includes('rate limit') ||
                       apiCallError.message?.includes('exceeded token rate limit') ||
                       apiCallError.message?.includes('AIServices S0 pricing tier');
```

### 2. TargetProcessor.ts

**Added rate limit error handling in executeCommand method:**

```typescript
// Call LLM to process target
let llmResponse;
try {
  llmResponse = await this.connector.callAgent(messages, modelOptions);
} catch (error: any) {
  // Check if it's a rate limit error
  if (error.message?.includes('Rate limit exceeded') || 
      error.message?.includes('exceeded token rate limit') ||
      error.message?.includes('AIServices S0 pricing tier')) {
    console.error(`[TargetProcessor] Rate limit error from connector: ${error.message}`);
    return {
      status: 'failed',
      error: `Rate limit exceeded: ${error.message}. Please try again later.`
    };
  }
  throw error; // Re-throw other errors
}
```

### 3. ToolEvaluator.ts

**Added rate limit error handling in evaluateCommand method:**

```typescript
// Llamar a la API a través del conector
let portkeyResponse;
try {
  portkeyResponse = await this.connector.callAgent(messages, modelOptions);
  console.log("[ToolEvaluator] Response received");
} catch (error: any) {
  // Check if it's a rate limit error
  if (error.message?.includes('Rate limit exceeded') || 
      error.message?.includes('exceeded token rate limit') ||
      error.message?.includes('AIServices S0 pricing tier')) {
    console.error(`[ToolEvaluator] Rate limit error from connector: ${error.message}`);
    return {
      status: 'failed',
      error: `Rate limit exceeded: ${error.message}. Please try again later.`
    };
  }
  throw error; // Re-throw other errors
}
```

### 4. AgentConnector.ts

**Added rate limit error handling in executeCommand method:**

```typescript
// Llamar al agente a través de Portkey
let portkeyResponse;
try {
  portkeyResponse = await this.connector.callAgent(messages, modelOptions);
} catch (error: any) {
  // Check if it's a rate limit error
  if (error.message?.includes('Rate limit exceeded') || 
      error.message?.includes('exceeded token rate limit') ||
      error.message?.includes('AIServices S0 pricing tier')) {
    console.error(`[AgentConnector:${this.id}] Rate limit error from connector: ${error.message}`);
    return {
      status: 'failed',
      error: `Rate limit exceeded: ${error.message}. Please try again later.`
    };
  }
  throw error; // Re-throw other errors
}
```

## Testing

A comprehensive test script has been created at `scripts/test-rate-limit-handling.mjs` that verifies:

1. **Error Detection**: Tests that rate limit errors are properly detected from various error structures
2. **Retry Logic**: Simulates the retry logic with proper wait times
3. **Error Scenarios**: Tests different types of rate limit errors and non-rate limit errors

### Running the Test

```bash
node scripts/test-rate-limit-handling.mjs
```

Expected output:
```
🚀 Starting rate limit error handling tests...

🧪 Testing different error scenarios...
✅ Test 1 - Status 429: PASSED
✅ Test 2 - Message contains rate limit: PASSED
✅ Test 3 - Nested body structure: PASSED
✅ Test 4 - Non-rate limit error: PASSED

==================================================

🧪 Testing rate limit error detection and retry logic...
📋 Testing error detection...
✅ Rate limit error detection: PASSED
🔄 Simulating retry logic...
📝 Attempt 1/3
❌ Attempt 1 failed with rate limit error
⏳ Rate limit error detected, waiting 60s as suggested by API...
⏳ (Simulated wait of 60s)
📝 Attempt 2/3
❌ Attempt 2 failed with rate limit error
⏳ Rate limit error detected, waiting 60s as suggested by API...
⏳ (Simulated wait of 60s)
📝 Attempt 3/3
❌ Attempt 3 failed with rate limit error
💥 Max retries reached, failing the command

📊 Final result: {
  "status": "failed",
  "error": "Rate limit exceeded: openai error: Requests to the ChatCompletions_Create Operation under OpenAI Language Model Instance API have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 60 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit. For Free Account customers, upgrade to Pay as you Go here: https://aka.ms/429TrialUpgrade.. Please try again later."
}

✅ All tests PASSED! Rate limit error handling is working correctly.
```

## Behavior Summary

### When a Rate Limit Error Occurs:

1. **Detection**: The system detects rate limit errors from multiple sources:
   - HTTP status code 429
   - Error messages containing "rate limit", "exceeded token rate limit", or "AIServices S0 pricing tier"
   - Nested error structures in response bodies

2. **Retry Logic**: 
   - For rate limit errors: Wait 60 seconds (as suggested by the API)
   - For other retryable errors: Use exponential backoff (1s, 2s, 4s)
   - Maximum of 3 retry attempts

3. **Graceful Failure**: If all retries fail, the command fails gracefully with a clear error message indicating the rate limit issue.

4. **Logging**: Comprehensive logging is added to track rate limit errors and retry attempts.

### Error Response Format:

When a rate limit error occurs and all retries are exhausted, the system returns:

```json
{
  "status": "failed",
  "error": "Rate limit exceeded: [original error message]. Please try again later."
}
```

## Files Modified

1. `src/lib/agentbase/services/PortkeyConnector.ts` - Enhanced retry logic and error detection
2. `src/lib/agentbase/agents/TargetProcessor.ts` - Added rate limit error handling
3. `src/lib/agentbase/agents/toolEvaluator/index.ts` - Added rate limit error handling
4. `src/lib/agentbase/agents/AgentConnector.ts` - Added rate limit error handling
5. `scripts/test-rate-limit-handling.mjs` - Comprehensive test suite

## Benefits

1. **Improved Reliability**: Commands no longer fail silently when rate limits are hit
2. **Better User Experience**: Clear error messages inform users about rate limit issues
3. **Automatic Recovery**: System automatically retries with appropriate delays
4. **Comprehensive Coverage**: Rate limit handling is implemented across all agent components
5. **Robust Error Detection**: Multiple error detection methods ensure no rate limit errors are missed


