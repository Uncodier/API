// Test script to verify property path validation
// Run with: node test_path_validation.js

// Example target with "contents" property 
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

// Example response with "type":"contents" and "content" property
const responseWrongStructure = [
  {
    "type": "contents",
    "content": [
      {
        "text": "# Uncodie: Revolutionizing Education with CMO as a Service...",
        "type": "blog_post",
        "title": "Uncodie: Revolutionizing Education with CMO as a Service",
        "description": "Explore how Uncodie is transforming the education sector...",
        "estimated_reading_time": 10
      }
    ]
  }
];

// Example response with correct structure matching target
const responseCorrectStructure = [
  {
    "contents": [
      {
        "text": "# Uncodie: Revolutionizing Education with CMO as a Service...",
        "type": "blog_post",
        "title": "Uncodie: Revolutionizing Education with CMO as a Service",
        "description": "Explore how Uncodie is transforming the education sector...",
        "estimated_reading_time": 10
      }
    ]
  }
];

// Simulate findContentPropertyPath
function findContentPropertyPath(obj) {
  // Check for direct properties
  if (obj.content) return 'content';
  if (obj.contents) return 'contents';
  
  // Check for nested content under type
  if (obj.type && obj[obj.type]) {
    if (Array.isArray(obj[obj.type])) return obj.type;
  }
  
  // Look for any array property that might be content
  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key])) {
      return key;
    }
  }
  
  return '';
}

// Simulate getPropertyByPath
function getPropertyByPath(obj, path) {
  if (!path) return null;
  return obj[path];
}

// Test property path detection
console.log('=== TESTING PROPERTY PATH DETECTION ===');

// Test 1: Target with "contents" property
const targetObj = target[0];
const targetPath = findContentPropertyPath(targetObj);
console.log(`Target object property path: "${targetPath}"`);
console.log(`Target content retrieved: ${Array.isArray(targetObj[targetPath]) ? 'Array with ' + targetObj[targetPath].length + ' items' : 'Not array'}`);

// Test 2: Response with "type":"contents" and "content" property
const responseWrongObj = responseWrongStructure[0];
const responseWrongPath = findContentPropertyPath(responseWrongObj);
console.log(`\nWrong response object property path: "${responseWrongPath}"`);
console.log(`Wrong response content retrieved: ${Array.isArray(responseWrongObj[responseWrongPath]) ? 'Array with ' + responseWrongObj[responseWrongPath].length + ' items' : 'Not array'}`);

// Test 3: Response with correct structure
const responseCorrectObj = responseCorrectStructure[0];
const responseCorrectPath = findContentPropertyPath(responseCorrectObj);
console.log(`\nCorrect response object property path: "${responseCorrectPath}"`);
console.log(`Correct response content retrieved: ${Array.isArray(responseCorrectObj[responseCorrectPath]) ? 'Array with ' + responseCorrectObj[responseCorrectPath].length + ' items' : 'Not array'}`);

// Now simulate the validation using property paths
console.log('\n=== SIMULATING VALIDATION USING PROPERTY PATHS ===');

// Test 1: Validate target against wrong structure response
const targetPathTest1 = findContentPropertyPath(targetObj);
const responsePath1 = findContentPropertyPath(responseWrongObj);

console.log(`Target path: ${targetPathTest1}`);
console.log(`Wrong response path: ${responsePath1}`);

if (targetPathTest1 !== responsePath1) {
  console.log('❌ VALIDATION FAILED: Property paths do not match');
  console.log(`   This correctly detects the structure mismatch between "contents" and "content"`);
} else {
  console.log('✅ Validation passed (this should not happen!)');
}

// Test 2: Validate target against correct structure response
const targetPathTest2 = findContentPropertyPath(targetObj);
const responsePath2 = findContentPropertyPath(responseCorrectObj);

console.log(`\nTarget path: ${targetPathTest2}`);
console.log(`Correct response path: ${responsePath2}`);

if (targetPathTest2 !== responsePath2) {
  console.log('❌ Validation failed (this should not happen!)');
} else {
  console.log('✅ VALIDATION PASSED: Property paths match correctly');
  console.log('   This correctly accepts the matching structure with "contents" property');
}

// Conclusion
console.log('\n=== CONCLUSION ===');
console.log('The enhanced property path validation correctly:');
console.log('1. Identifies the exact property path to content in each object');
console.log('2. Detects structure mismatches when property paths differ');
console.log('3. Validates matching structures when property paths are the same');
console.log('\nThis addresses the core issue where target had "contents" but response had "type"+"content"'); 