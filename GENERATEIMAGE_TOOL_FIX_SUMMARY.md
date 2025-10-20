# Generate Image Tool Scrapybara Compatibility Fix

## Problem

When executing robot plans with `generateImageTool`, the system crashed with:
```
TypeError: Cannot read properties of undefined (reading 'typeName')
    at Array.map (<anonymous>)
    at actStream_1.next (<anonymous>)
```

## Root Cause

`generateImageTool` was returning a plain object compatible with OpenAI function calling format (JSON Schema), but Scrapybara SDK requires tools to be created using the `tool()` helper from `scrapybara/tools`, which wraps them with internal properties like `typeName`.

## Solution Implemented

Created two versions of the tool to maintain compatibility with both execution contexts:

### 1. `generateImageTool(site_id)` - OpenAI/Azure Compatible
- **Location**: `src/app/api/agents/tools/generateImage/assistantProtocol.ts`
- **Format**: Plain object with JSON Schema parameters
- **Used by**: `src/app/api/robots/instance/assistant/route.ts`
- **Context**: OpenAI/Azure executors via `custom_tools` parameter

### 2. `generateImageToolScrapybara(instance, site_id)` - Scrapybara SDK Compatible
- **Location**: `src/app/api/agents/tools/generateImage/assistantProtocol.ts`
- **Format**: Wrapped with `tool()` helper, uses Zod schemas
- **Used by**: `src/app/api/robots/plan/act/route.ts`
- **Context**: Scrapybara SDK via `client.act()`

## Changes Made

### File: `src/app/api/agents/tools/generateImage/assistantProtocol.ts`

**Added imports:**
```typescript
import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';
```

**Added function:**
```typescript
export function generateImageToolScrapybara(instance: UbuntuInstance, site_id: string) {
  return tool({
    name: 'generate_image',
    description: '...',
    parameters: z.object({
      prompt: z.string().describe('...'),
      provider: z.enum(['gemini']).optional().describe('...'),
      size: z.enum(['256x256', '512x512', '1024x1024']).optional().describe('...'),
      // ... other Zod schema definitions
    }),
    execute: async (args) => {
      // Same business logic as original generateImageTool
    }
  });
}
```

### File: `src/app/api/robots/plan/act/route.ts`

**Changed import:**
```typescript
// Before
import { generateImageTool } from '@/app/api/agents/tools/generateImage/assistantProtocol';

// After
import { generateImageToolScrapybara } from '@/app/api/agents/tools/generateImage/assistantProtocol';
```

**Changed tool instantiation:**
```typescript
// Before (line 421-422)
const generateImageToolInstance = generateImageTool(instance.site_id);
tools.push(generateImageToolInstance);

// After (line 421-422)
const generateImageToolInstance = generateImageToolScrapybara(ubuntuInstance, instance.site_id);
tools.push(generateImageToolInstance);
```

## Verification

✅ No linter errors introduced
✅ Both execution contexts maintain their specific tool format
✅ Business logic remains shared (ImageGenerationService)
✅ No breaking changes to existing functionality

## Files Modified

1. `src/app/api/agents/tools/generateImage/assistantProtocol.ts` - Added Scrapybara version
2. `src/app/api/robots/plan/act/route.ts` - Updated to use Scrapybara version

## Files Verified (No Changes Needed)

- `src/app/api/robots/instance/assistant/route.ts` - Continues using original version correctly

## Testing Recommendation

Test both execution paths:
1. Plan execution via `/api/robots/plan/act` - Should use Scrapybara SDK successfully
2. Assistant execution via `/api/robots/instance/assistant` - Should continue working with OpenAI/Azure

## Date

October 20, 2025

