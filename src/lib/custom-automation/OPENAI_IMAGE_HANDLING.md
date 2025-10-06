# OpenAI Image Handling - Critical Implementation Details

## The Problem

When implementing a custom agent executor with Azure OpenAI, you might encounter this error:

```
400 Invalid 'messages[5]'. Image URLs are only allowed for messages with role 'user', 
but this message with role 'tool' contains an image URL.
```

## Root Cause

**OpenAI API Restriction**: Unlike some other providers, OpenAI does NOT allow images in messages with role `'tool'`. Images can ONLY appear in messages with role `'user'`.

This is different from how tool results work in other APIs:
- **Anthropic Claude**: Allows images in tool results
- **OpenAI GPT**: Does NOT allow images in tool role messages

## How Scrapybara Handles This

After analyzing the Scrapybara SDK source code (`node_modules/scrapybara/`), we found:

1. **Scrapybara uses a custom internal message format** with types like:
   - `ToolResultPart`: Contains a `result` field that can include `base64Image`
   - `ImagePart`: Separate image representation
   - `TextPart`: Text content

2. **Their backend handles provider-specific conversion**:
   - The `act()` method sends messages to Scrapybara's backend API
   - The backend converts their internal format to each provider's requirements
   - For OpenAI: Images are extracted from tool results and sent as user messages

3. **Image management strategy**:
   ```javascript
   // From node_modules/scrapybara/ScrapybaraClient.js:716
   function _filterImages(messages, imagesToKeep) {
     let imagesKept = 0;
     for (let i = messages.length - 1; i >= 0; i--) {
       const msg = messages[i];
       if (msg.role === "tool" && Array.isArray(msg.content)) {
         for (let j = msg.content.length - 1; j >= 0; j--) {
           const toolResult = msg.content[j];
           if (toolResult && toolResult.result && toolResult.result.base64Image) {
             if (imagesKept < imagesToKeep) {
               imagesKept++;
             } else {
               delete toolResult.result.base64Image; // Remove old images
             }
           }
         }
       }
     }
   }
   ```

## Our Solution

Since we're calling OpenAI directly (not through Scrapybara's backend), we need to implement the provider-specific conversion ourselves.

### Implementation Pattern

```typescript
// 1. Extract image from tool result
const { cleanedResult, base64Image } = extractBase64Image(result);

// 2. Add 'tool' message with text only (NO image)
messages.push({
  role: 'tool',
  tool_call_id: toolCall.toolCallId,
  name: toolCall.toolName,
  content: typeof cleanedResult === 'string' 
    ? cleanedResult 
    : JSON.stringify(cleanedResult),
});

// 3. If there was an image, add it as a separate 'user' message
if (base64Image) {
  messages.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Here is the visual result from the previous action:'
      },
      {
        type: 'image_url',
        image_url: {
          url: base64Image,
          detail: 'low'  // Use 'low' to save tokens
        }
      }
    ]
  });
}
```

### Key Implementation Details

1. **Keep full result for logging**:
   ```typescript
   // Store FULL result in toolResults for onStep callback (includes image)
   toolResults.push({
     toolCallId: toolCall.toolCallId,
     toolName: toolCall.toolName,
     result, // Original result with image
     isError: false,
   });
   ```

2. **Message flow becomes**:
   ```
   [assistant] → "I'll take a screenshot"
   [tool call] → computer.take_screenshot()
   [tool] → "Screenshot captured successfully." (no image)
   [user] → "Here is the visual result:" + [IMAGE]
   [assistant] → "I can see in the screenshot that..."
   ```

3. **Image detection**:
   ```typescript
   // Detect base64 images by:
   // - Field name: 'base64_image', 'base64Image', 'screenshot', 'image'
   // - Data URI prefix: 'data:image/'
   // - String length: > 10000 characters (likely base64)
   // - Base64 header: '/9j/' (JPEG signature)
   ```

## Token Optimization

Images consume many tokens. Use these strategies:

1. **Use 'low' detail mode**: 85 tokens per image vs 765+ tokens for 'high'
   ```typescript
   image_url: {
     url: base64Image,
     detail: 'low'  // Saves ~680 tokens per image
   }
   ```

2. **Keep only recent images**: Like Scrapybara's `imagesToKeep` parameter (default: 4)

3. **Strip images from context**: Only send images from recent tool calls

## References

- **OpenAI Vision API**: https://platform.openai.com/docs/guides/vision
- **Azure OpenAI Vision**: https://learn.microsoft.com/azure/ai-services/openai/how-to/gpt-with-vision
- **Scrapybara SDK**: https://github.com/scrapybara/scrapybara-js
- **Message role restrictions**: OpenAI does not support images in 'tool' role messages

## Testing

To verify the implementation works:

```typescript
// Test that tool results with images are properly split
const result = {
  output: "Screenshot taken",
  base64Image: "iVBORw0KGgoAAAANSUhEUg..." // long base64 string
};

const { cleanedResult, base64Image } = extractBase64Image(result);

// cleanedResult should have image stripped
// base64Image should contain the image data
// Two messages should be added: one 'tool', one 'user'
```

## Conclusion

This implementation replicates Scrapybara's backend behavior for OpenAI models, allowing direct Azure OpenAI integration while maintaining compatibility with Scrapybara SDK tools.

The key insight: **OpenAI requires images in 'user' messages, not 'tool' messages.**

