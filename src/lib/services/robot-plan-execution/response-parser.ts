/**
 * Response Parser Service
 * Handles extraction and parsing of structured JSON responses from agent outputs
 */

/**
 * Extract and parse structured JSON response from agent text
 */
export function extractStructuredResponse(text: string): {
  event: string;
  step: number;
  assistant_message: string;
} | null {
  try {
    // Search for JSON in code blocks or plain text - more robust patterns
    const jsonPatterns = [
      // JSON in markdown code blocks
      /```json\s*([\s\S]*?)\s*```/gi,
      /```\s*([\s\S]*?)\s*```/gi,
      // JSON at end of text (more specific pattern)
      /\{[\s\S]*?"event"\s*:\s*"[^"]*"[\s\S]*?"step"\s*:\s*\d+[\s\S]*?"assistant_message"\s*:\s*"[\s\S]*?"\s*\}(?=\s*$)/gi,
      // JSON anywhere in text
      /\{[\s\S]*?"event"[\s\S]*?"step"[\s\S]*?"assistant_message"[\s\S]*?\}/gi,
      // More flexible JSON with single or double quotes
      /\{[^}]*"event"[^}]*"step"[^}]*"assistant_message"[^}]*\}/gi,
    ];
    
    for (const pattern of jsonPatterns) {
      // Reset regex index to avoid issues with global flags
      pattern.lastIndex = 0;
      let match;
      
      while ((match = pattern.exec(text)) !== null) {
        try {
          const jsonStr = (match[1] || match[0]).trim();
          
          // Try to clean JSON before parsing
          let cleanJsonStr = jsonStr;
          
          // Remove unnecessary escape characters
          cleanJsonStr = cleanJsonStr.replace(/\\n/g, '\n');
          cleanJsonStr = cleanJsonStr.replace(/\\"/g, '"');
          
          // Try parsing
          const parsed = JSON.parse(cleanJsonStr);
          
          // Validate it has exactly the required fields
          if (parsed.event && 
              typeof parsed.step === 'number' && 
              parsed.assistant_message &&
              typeof parsed.event === 'string' &&
              typeof parsed.assistant_message === 'string') {
            
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Successfully extracted: event=${parsed.event}, step=${parsed.step}`);
            
            return {
              event: parsed.event.toLowerCase().trim(),
              step: parsed.step,
              assistant_message: parsed.assistant_message.trim()
            };
          } else {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Invalid structure:`, parsed);
          }
        } catch (parseError) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Parse failed for: ${(match[1] || match[0]).substring(0, 100)}...`);
          continue;
        }
      }
    }
    
    // Try to find any valid JSON as last resort
    try {
      const lastJsonMatch = text.match(/\{[^{}]*\}/g);
      if (lastJsonMatch) {
        for (const jsonCandidate of lastJsonMatch.reverse()) {
          try {
            const parsed = JSON.parse(jsonCandidate);
            if (parsed.event && typeof parsed.step === 'number' && parsed.assistant_message) {
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Fallback extraction successful`);
              return {
                event: parsed.event.toLowerCase().trim(),
                step: parsed.step,
                assistant_message: parsed.assistant_message.trim()
              };
            }
          } catch (e) {
            continue;
          }
        }
      }
    } catch (fallbackError) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Fallback extraction failed`);
    }
    
    // If no valid JSON found, return null
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] No valid structured JSON response found in agent text`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Text sample: ${text.substring(text.length - 200)}`);
    return null;
  } catch (error) {
    console.error('Error extracting structured response:', error);
    return null;
  }
}

/**
 * Extract new plan content from agent text
 */
export function extractNewPlanFromText(text: string): any {
  try {
    // Search for content between plan markers or JSON
    const planMarkers = [
      /```json\s*([\s\S]*?)\s*```/i,
      /```\s*([\s\S]*?)\s*```/i,
      /PLAN:\s*([\s\S]*?)(?:\n\n|\nEND|$)/i,
      /NEW PLAN:\s*([\s\S]*?)(?:\n\n|\nEND|$)/i,
    ];
    
    for (const marker of planMarkers) {
      const match = text.match(marker);
      if (match) {
        try {
          // Try parsing as JSON first
          return JSON.parse(match[1].trim());
        } catch {
          // If not JSON, return as structured text
          return {
            title: 'Generated Plan',
            description: match[1].trim(),
            steps: match[1].trim().split('\n').filter(line => line.trim().length > 0)
              .map((step, index) => ({
                title: step.trim(),
                description: step.trim(),
                order: index + 1,
                status: 'pending'
              }))
          };
        }
      }
    }
    
    // If no markers found, use all text
    return {
      title: 'Agent Generated Plan',
      description: text.trim(),
      steps: text.split('\n').filter(line => line.trim().length > 0)
        .slice(0, 10) // Limit to 10 steps max
        .map((step, index) => ({
          title: step.trim().substring(0, 100), // Limit title
          description: step.trim(),
          order: index + 1,
          status: 'pending'
        }))
    };
  } catch (error) {
    console.error('Error extracting plan from text:', error);
    return null;
  }
}
