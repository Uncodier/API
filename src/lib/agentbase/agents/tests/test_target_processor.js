// Test script for TargetProcessorAgent validation logic
// Run with: node test_target_processor.js

// Import our validation function
import { validateResults } from '../targetEvaluator/validateResults.js';

// Define the target structure with placeholder content
const targets = [
  {
    "type": "contents",
    "content": [
      {
        "text": "markdown detailed copy",
        "type": "blog_post",
        "title": "title of the content", 
        "description": "summary of the content",
        "estimated_reading_time": 5
      }
    ]
  }
];

// Define the response with a DIFFERENT structure to trigger our validation issue
// The real issue is when the response has a different structure than what was expected
const testResponse = [
  {
    "type": "contents",
    "content": "## The Role of Educational Technology in Modern Learning\n\n### Introduction\n\nIn today's rapidly evolving educational landscape, technology plays a pivotal role in enhancing learning experiences. From online learning platforms to innovative classroom tools, educational technology is transforming how educators teach and students learn.\n\n### The Rise of Online Learning\n\nOnline learning has become a cornerstone of modern education. With the flexibility to learn from anywhere, students can access a wealth of resources and courses that were previously unavailable. This shift has been particularly beneficial for adult learners and those in remote areas.\n\n### Innovations in School Administration\n\nEducational technology is not just limited to the classroom. School administration has also seen significant advancements. Tools for managing student data, scheduling, and communication have streamlined administrative tasks, allowing educators to focus more on teaching.\n\n### The Future of Education\n\nAs technology continues to evolve, so too will its impact on education. Emerging trends such as artificial intelligence, virtual reality, and personalized learning are set to further revolutionize the educational landscape.\n\n### Conclusion\n\nEducational technology is here to stay, and its benefits are clear. By embracing these tools, educators can provide more engaging, effective, and accessible learning experiences for all students.\n"
    // Notice here the content is a string, not an array of objects as expected in the target
  }
];

// A second test case where the response structure is completely different
const testResponse2 = [
  {
    "type": "blog_post", // Type is wrong, should be "contents"
    "content": [
      {
        "body": "## The Role of Educational Technology in Modern Learning...", // "body" instead of "text"
        "category": "education", // Extra field not in target
        "author": "AI Assistant", // Extra field not in target
        // Missing "type", "title", "description", and "estimated_reading_time"
      }
    ]
  }
];

// Third test case where the LLM returned the template verbatim 
const testResponse3 = [
  {
    "type": "contents",
    "content": [
      {
        "text": "markdown detailed copy", // Exactly same as template!
        "type": "blog_post",
        "title": "title of the content", 
        "description": "summary of the content",
        "estimated_reading_time": 5
      }
    ]
  }
];

// Add a valid test case to verify our validator allows correct responses
const validResponse = [
  {
    "type": "contents",
    "content": [
      {
        "text": "# Educational Technology in Modern Learning\n\nTechnology has revolutionized how we approach education in the 21st century.",
        "type": "blog_post",
        "title": "The Impact of EdTech on Learning", 
        "description": "How technology is changing education globally",
        "estimated_reading_time": 8
      }
    ]
  }
];

console.log("=== Target Structure ===");
console.log(JSON.stringify(targets[0], null, 2));

// Function to test validation with each response
function testValidation(response, testCase) {
  console.log(`\n\n=============== TEST CASE ${testCase} ===============`);
  console.log("\n=== Response Structure ===");
  console.log(JSON.stringify(response[0], null, 2));

  // Run the new validation function
  console.log("\n=== New Validation Results ===");
  const validationResult = validateResults(response, targets);
  
  console.log(`Valid: ${validationResult.isValid}`);
  if (!validationResult.isValid) {
    console.log(`Error: ${validationResult.error}`);
  }

  // Previous validation function for comparison
  function oldValidateResultsStructure(results, targets) {
    console.log("\n=== Original Validation Results ===");

    if (!Array.isArray(results) || !Array.isArray(targets)) {
      console.log('❌ Results or targets are not arrays');
      return false;
    }

    if (results.length !== targets.length) {
      console.log(`❌ Length mismatch: results=${results.length}, targets=${targets.length}`);
      return false;
    }

    // Validate each target against its corresponding result
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const result = results[i];
      
      // Get target type
      const targetType = target.type || Object.keys(target)[0];
      
      // Verify result type matches target type
      if (result.type !== targetType) {
        console.log(`❌ Type mismatch: result="${result.type}", target="${targetType}"`);
        return false;
      }
      
      // Get content
      const targetContent = target[targetType] || target.content;
      const resultContent = result.content;
      
      if (!targetContent || !resultContent) {
        console.log('❌ Missing content in target or result');
        return false;
      }
      
      // THIS IS WHERE THE BUG IS:
      // The original code doesn't properly detect structure mismatches in complex array content
      console.log('✓ Has both targetContent and resultContent');
      console.log(`✓ Target content type: ${Array.isArray(targetContent) ? 'array' : typeof targetContent}`);
      console.log(`✓ Result content type: ${Array.isArray(resultContent) ? 'array' : typeof resultContent}`);
      
      // If one is array and other is not, this is a structure mismatch
      if (Array.isArray(targetContent) !== Array.isArray(resultContent)) {
        console.log('❌ Content structure mismatch: one is array, other is not');
        console.log("This should fail but original code might miss this!");
      } 
      // For complex arrays, validation was insufficient 
      else if (Array.isArray(targetContent) && Array.isArray(resultContent)) {
        if (targetContent.length > 0 && resultContent.length > 0) {
          console.log('✓ Both are non-empty arrays');
          
          // The issue: First item sanity check wasn't sufficient
          const targetItem = targetContent[0];
          const resultItem = resultContent[0];
          
          if (typeof targetItem === 'object' && typeof resultItem === 'object') {
            console.log('✓ First items in both arrays are objects');
            
            // Check if important fields exist in both
            const targetKeys = Object.keys(targetItem);
            const resultKeys = Object.keys(resultItem);
            
            console.log(`Target keys: ${targetKeys.join(', ')}`);
            console.log(`Result keys: ${resultKeys.join(', ')}`);
            
            const missingKeys = targetKeys.filter(key => !resultKeys.includes(key));
            if (missingKeys.length > 0) {
              console.log(`❌ Missing expected keys in result: ${missingKeys.join(', ')}`);
              console.log("This should fail but original code might miss this!");
            }
          }
        }
      }
    }

    console.log('⚠️ Original validation might incorrectly pass for this structure mismatch!');
    return true;
  }

  // Run the old validation for comparison
  oldValidateResultsStructure(response, targets);
}

// Run tests with all the test cases
testValidation(testResponse, 1);
testValidation(testResponse2, 2);
testValidation(testResponse3, 3);
testValidation(validResponse, 4);

console.log("\n\n============== SUMMARY ==============");
console.log("Our new validation function should:");
console.log("1. Reject responses where content structure doesn't match (string vs array)");
console.log("2. Reject responses with wrong type or missing required fields");
console.log("3. Reject responses that just repeat the template/placeholders");
console.log("4. Accept valid responses that have the correct structure and meaningful content"); 