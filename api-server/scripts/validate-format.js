/**
 * Validation script for TargetProcessorAgent output format
 * This script simulates the structure-checking part of the fix
 */

// Example target with array content
const target = {
  contents: [
    {
      type: 'blog_post', 
      text: 'markdown detailed copy',
      title: 'title of the content',
      description: 'summary of the content'
    }
  ]
};

// Example response with a single object (problem case)
const badResponse = {
  type: 'contents',
  content: {
    type: 'blog_post',
    text: 'This is a single blog post',
    title: 'Single Post',
    description: 'Testing'
  }
};

// Fixed response with properly wrapped array
const goodResponse = {
  type: 'contents',
  contents: [{
    type: 'blog_post',
    text: 'This is a single blog post',
    title: 'Single Post',
    description: 'Testing'
  }]
};

function validateStructure(target, response) {
  console.log('🧪 Testing structure validation...');
  
  // Check top-level properties
  const targetKeys = Object.keys(target);
  const responseKeys = Object.keys(response);
  
  console.log(`Target keys: ${targetKeys.join(', ')}`);
  console.log(`Response keys: ${responseKeys.join(', ')}`);
  
  // Check for content/contents property match
  if (target.contents && !response.contents) {
    console.log('❌ PROBLEM: Target uses "contents" but response uses "content"');
    
    // Fix 1: Ensure property name matches
    console.log('✅ FIX 1: Rename response property to match target');
    const fixed1 = {...response};
    if (fixed1.content) {
      fixed1.contents = fixed1.content;
      delete fixed1.content;
    }
    console.log('Result:', JSON.stringify(fixed1, null, 2));
    
    return false;
  }
  
  // Check if array structure is preserved
  if (Array.isArray(target.contents) && !Array.isArray(response.contents)) {
    console.log('❌ PROBLEM: Target content is array but response content is not');
    
    // Fix 2: Wrap in array
    console.log('✅ FIX 2: Wrap response content in array');
    const fixed2 = {...response};
    if (fixed2.contents && !Array.isArray(fixed2.contents)) {
      fixed2.contents = [fixed2.contents];
    }
    console.log('Result:', JSON.stringify(fixed2, null, 2));
    
    return false;
  }
  
  console.log('✅ SUCCESS: Response structure matches target structure');
  return true;
}

// Test the bad response
console.log('\n===== TESTING BAD RESPONSE =====');
const badResult = validateStructure(target, badResponse);
console.log(`Validation result: ${badResult ? 'PASS' : 'FAIL'}`);

// Test the good response
console.log('\n===== TESTING GOOD RESPONSE =====');
const goodResult = validateStructure(target, goodResponse);
console.log(`Validation result: ${goodResult ? 'PASS' : 'FAIL'}`);

// Test both fixes combined
console.log('\n===== TESTING COMBINED FIXES =====');
console.log('Starting with the bad response and applying all fixes...');

const fullFixed = {...badResponse};

// Fix 1: Rename property to match target
if (target.contents && !fullFixed.contents && fullFixed.content) {
  fullFixed.contents = fullFixed.content;
  delete fullFixed.content;
  console.log('✅ Applied Fix 1: Renamed content to contents');
}

// Fix 2: Ensure array structure
if (Array.isArray(target.contents) && !Array.isArray(fullFixed.contents)) {
  fullFixed.contents = [fullFixed.contents];
  console.log('✅ Applied Fix 2: Wrapped content in array');
}

console.log('\nFinal fixed structure:');
console.log(JSON.stringify(fullFixed, null, 2));

// Validate the fully fixed result
console.log('\nValidating the fixed result:');
const finalResult = validateStructure(target, fullFixed);
console.log(`Final validation result: ${finalResult ? 'PASS ✅' : 'FAIL ❌'}`);

// Real-world example from user query
console.log('\n===== TESTING REAL-WORLD EXAMPLE =====');

// Target structure from real issue
const realTarget = {
  contents: [
    {
      type: 'blog_post',
      text: 'markdown detailed copy',
      title: 'title of the content',
      description: 'summary of the content',
      estimated_reading_time: 5
    }
  ]
};

// Response structure that caused the issue - notice it has the blog post object but not in an array
const realBadResponse = {
  contents: {
    text: '# The Role of Educational Technology in Modern Learning\n\n## Introduction\nEducational technology has revolutionized the way educators...',
    type: 'blog_post',
    title: 'The Role of Educational Technology in Modern Learning',
    description: 'Explore the impact of educational technology on modern learning...',
    estimated_reading_time: 10
  }
};

console.log('Real-world problematic response:');
console.log(JSON.stringify(realBadResponse, null, 2).substring(0, 150) + '...');

// Fix the real-world example
const realFixed = {...realBadResponse};

// Only need to fix the array structure
if (Array.isArray(realTarget.contents) && !Array.isArray(realFixed.contents)) {
  realFixed.contents = [realFixed.contents];
  console.log('✅ Applied Fix: Wrapped content in array');
}

console.log('\nFixed real-world structure:');
console.log(JSON.stringify(realFixed, null, 2).substring(0, 150) + '...');

// Validate the real-world fixed result
console.log('\nValidating the real-world fixed result:');
const realResult = validateStructure(realTarget, realFixed);
console.log(`Real-world validation result: ${realResult ? 'PASS ✅' : 'FAIL ❌'}`);

// Output a summary of what the fix does
console.log('\n===== FIX SUMMARY =====');
console.log('The fix implemented in TargetProcessorAgent addresses two critical issues:');
console.log('1. Property name mismatch: Ensures response uses "contents" when target uses "contents"');
console.log('2. Array structure preservation: Ensures single objects are always wrapped in an array');
console.log('\nThis prevents validation failures and ensures integrity of the response structure.');

// Add this npm script to: npm run validate-format 