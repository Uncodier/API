// Test script for TargetProcessorAgent fixed validation
// Run with: node test_fixed_validation.js

// Target data from the user
const target = [
  {
    "contents": [
      {
        "text": "markdown detailed copy",
        "type": "blog_post",
        "title": "title of the content",
        "description": "summary of the content",
        "estimated_reading_time": 10
      }
    ]
  }
];

// Response data from the user
const response = [
  {
    "type": "contents",
    "content": [
      {
        "text": "# Uncodie: Revolutionizing Education with CMO as a Service\n\n## Introduction\nIn the rapidly evolving landscape of education technology...",
        "type": "blog_post",
        "title": "Uncodie: Revolutionizing Education with CMO as a Service",
        "description": "Explore how Uncodie is transforming the education sector with its unique CMO as a Service offering, designed to enhance marketing strategies and improve educational outcomes.",
        "estimated_reading_time": 10
      }
    ]
  }
];

// Simulate the validation process with the new stricter approach
console.log('=== Starting Fixed Validation Test ===');

// Then we validate with strict property validation
function validateResultsStructure(results, targets) {
  console.log('\nValidating structure with strict property validation...');
  
  if (!Array.isArray(results) || !Array.isArray(targets)) {
    console.log('❌ Results or targets are not arrays');
    return false;
  }

  // Check lengths match
  if (results.length !== targets.length) {
    console.log(`❌ Length mismatch: results=${results.length}, targets=${targets.length}`);
    return false;
  }

  console.log(`Validating ${results.length} results against ${targets.length} targets`);

  // Compare each result with its corresponding target
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const result = results[i];
    
    // CRITICAL FIX: Check exact property structure first, before any content validation
    const targetKeys = Object.keys(target);
    const resultKeys = Object.keys(result);
    
    console.log(`Target keys: ${targetKeys.join(', ')}`);
    console.log(`Result keys: ${resultKeys.join(', ')}`);
    
    // Require exact structure match - all properties must be the same
    for (const key of targetKeys) {
      if (!resultKeys.includes(key)) {
        console.log(`❌ Structure mismatch - missing property "${key}" in result`);
        return false;
      }
    }
    
    for (const key of resultKeys) {
      if (!targetKeys.includes(key)) {
        console.log(`❌ Structure mismatch - property "${key}" in result doesn't exist in target`);
        return false;
      }
    }
    
    // Structure matched, continue with validation
    console.log('✅ Structure check passed');
  }

  console.log('✅ All structure validations passed successfully');
  return true;
}

// Run the validation
console.log('\n=== STRUCTURE VALIDATION ===');
console.log('Target:', JSON.stringify(target[0]).substring(0, 100) + '...');
console.log('Response:', JSON.stringify(response[0]).substring(0, 100) + '...');

// Run validation - should fail with structural mismatch
const validationResult = validateResultsStructure(response, target);
console.log(`\nValidation result: ${validationResult ? 'PASSED ✅' : 'FAILED ❌'}`);

// Final output
console.log('\n=== CONCLUSION ===');
if (!validationResult) {
  console.log('✅ STRICT VALIDATION WORKS: Correctly detected the structure mismatch');
  console.log('When target has "contents" but response has "type"+"content"');
  console.log('We fail fast without trying to transform the structure');
} else {
  console.log('❌ TEST FAILED: Validation passed when it should have failed');
} 