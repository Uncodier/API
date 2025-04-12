// Test script for TargetProcessorAgent structure preservation
// Run with: node test_target_structure_preservation.js

import { formatTargetProcessorPrompt, TARGET_PROCESSOR_SYSTEM_PROMPT } from '../../prompts/target-processor-prompt.ts';

// Define example targets with specific structures that could cause issues
const targets = [
  {
    // Target with "contents" property (not "content")
    "contents": [
      {
        "type": "blog_post",
        "text": "markdown detailed copy",
        "title": "Example Blog Post",
        "description": "This is a placeholder for a blog post",
        "estimated_reading_time": 5
      }
    ]
  },
  {
    // Target with nested complex structure
    "type": "analysis",
    "data": {
      "metrics": [
        { "name": "engagement", "value": 0, "unit": "percent" },
        { "name": "conversion", "value": 0, "unit": "rate" }
      ],
      "insights": []
    }
  }
];

// Show the system prompt instructions about structure preservation
console.log("=== TARGET PROCESSOR SYSTEM PROMPT EXCERPTS ===");
const structureInstructions = TARGET_PROCESSOR_SYSTEM_PROMPT.split('\n')
  .filter(line => line.includes('structure') || line.includes('EXACT'))
  .join('\n');
console.log(structureInstructions);
console.log("\n");

// Generate the formatted prompt that would be sent to the LLM
const userMessage = "Create a blog post about technology in education and analyze its potential impact";
const formattedPrompt = formatTargetProcessorPrompt(userMessage, targets);

console.log("=== FORMATTED PROMPT ===");
console.log(formattedPrompt);
console.log("\n");

// Show what a correct response structure would look like (preserving exact target structure)
console.log("=== EXPECTED RESPONSE STRUCTURE ===");
const expectedResponse = [
  {
    // Same structure as first target
    "contents": [
      {
        "type": "blog_post",
        "text": "# Technology in Education\n\nEducational technology is transforming how students learn...",
        "title": "Technology in Education: A Revolution in Learning",
        "description": "How modern technology is changing the face of education worldwide",
        "estimated_reading_time": 8
      }
    ]
  },
  {
    // Same structure as second target
    "type": "analysis",
    "data": {
      "metrics": [
        { "name": "engagement", "value": 85, "unit": "percent" },
        { "name": "conversion", "value": 0.15, "unit": "rate" }
      ],
      "insights": [
        "Educational technology content draws high engagement",
        "Teachers and administrators are primary audience"
      ]
    }
  }
];
console.log(JSON.stringify(expectedResponse, null, 2));

// Simple validation to check structure preservation
function validateStructure(targets, response) {
  console.log("\n=== STRUCTURE VALIDATION ===");
  
  if (!Array.isArray(targets) || !Array.isArray(response)) {
    console.log("❌ Validation failed: targets or response is not an array");
    return false;
  }
  
  if (targets.length !== response.length) {
    console.log(`❌ Validation failed: target count (${targets.length}) != response count (${response.length})`);
    return false;
  }
  
  let isValid = true;
  
  targets.forEach((target, index) => {
    const result = response[index];
    
    // Compare top-level keys
    const targetKeys = Object.keys(target).sort();
    const resultKeys = Object.keys(result).sort();
    
    console.log(`Target ${index + 1} keys: ${targetKeys.join(', ')}`);
    console.log(`Result ${index + 1} keys: ${resultKeys.join(', ')}`);
    
    const keysMatch = JSON.stringify(targetKeys) === JSON.stringify(resultKeys);
    console.log(`Top-level structure match: ${keysMatch ? '✅' : '❌'}`);
    
    if (!keysMatch) {
      isValid = false;
    }
    
    // Check for content/contents mismatch specifically (common issue)
    if (target.contents && result.content) {
      console.log(`❌ Property mismatch: target has 'contents' but result has 'content'`);
      isValid = false;
    } else if (target.content && result.contents) {
      console.log(`❌ Property mismatch: target has 'content' but result has 'contents'`);
      isValid = false;
    }
  });
  
  console.log(`\nOverall validation: ${isValid ? '✅ PASSED' : '❌ FAILED'}`);
  return isValid;
}

// Validate our expected response
validateStructure(targets, expectedResponse);

// Example of an incorrect response (with structure changes) for comparison
const incorrectResponse = [
  {
    // Changed "contents" to "content" - this is a common error
    "content": [
      {
        "type": "blog_post",
        "text": "# Technology in Education\n\nEducational technology is transforming how students learn...",
        "title": "Technology in Education: A Revolution in Learning",
        "description": "How modern technology is changing the face of education worldwide",
        "estimated_reading_time": 8
      }
    ]
  },
  {
    // Changed structure of data.metrics
    "type": "analysis",
    "data": {
      "metrics": {
        "engagement": { "value": 85, "unit": "percent" },
        "conversion": { "value": 0.15, "unit": "rate" }
      },
      "insights": [
        "Educational technology content draws high engagement",
        "Teachers and administrators are primary audience"
      ]
    }
  }
];

console.log("\n=== INCORRECT RESPONSE EXAMPLE ===");
console.log(JSON.stringify(incorrectResponse, null, 2));
validateStructure(targets, incorrectResponse); 