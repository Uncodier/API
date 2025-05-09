/**
 * Test script for validating the real-world blog post example from the TargetProcessorAgent
 * This script tests the exact structure provided by the user
 */

// Target structure from user's input
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

// Response structure that should be valid but is currently failing
const response = [
  {
    "contents": [
      {
        "text": "## The Future of Education: Integrating Technology for Enhanced Learning Experiences\n\nIn today's rapidly evolving educational landscape, integrating innovative technology solutions is no longer a luxury but a necessity. As educators and institutions strive to enhance learning experiences, the role of technology has become increasingly pivotal. This blog post delves into the various ways technology is revolutionizing education, the benefits it brings, and the challenges that need to be addressed.\n\n### The Role of Technology in Modern Education\n\nTechnology in education is transforming traditional teaching methods, making learning more interactive, engaging, and accessible. From online learning platforms to educational apps, technology offers a plethora of tools that cater to diverse learning needs. Here are some key areas where technology is making a significant impact:\n\n1. **Online Learning**: With the advent of online learning platforms, education is no longer confined to the four walls of a classroom. Students can access courses from anywhere in the world, at any time, making learning more flexible and convenient.\n\n2. **Educational Technology Tools**: Tools such as interactive whiteboards, virtual reality (VR), and augmented reality (AR) are making learning more immersive and engaging. These tools help in visualizing complex concepts, making them easier to understand.\n\n3. **School Administration**: Technology is streamlining administrative tasks, allowing educators to focus more on teaching. Automated attendance systems, digital grade books, and communication platforms are making school administration more efficient.\n\n4. **Innovation in Education**: Technology fosters innovation by providing educators with new ways to teach and students with new ways to learn. From gamified learning to personalized learning paths, technology is opening up new possibilities in education.\n\n### Benefits of Integrating Technology in Education\n\nThe integration of technology in education brings numerous benefits, including:\n\n- **Enhanced Learning Experiences**: Technology makes learning more interactive and engaging, helping students retain information better.\n- **Accessibility**: Online learning platforms make education accessible to students from different geographical locations and backgrounds.\n- **Personalized Learning**: Technology allows for personalized learning experiences, catering to the individual needs and learning styles of students.\n- **Efficiency**: Technology streamlines administrative tasks, making school management more efficient.\n\n### Challenges in Integrating Technology in Education\n\nWhile the benefits are numerous, integrating technology in education also comes with its challenges:\n\n- **Digital Divide**: Not all students have access to the necessary technology and internet connectivity, leading to a digital divide.\n- **Training and Support**: Educators need proper training and support to effectively integrate technology into their teaching methods.\n- **Cost**: The initial cost of implementing technology can be high, making it difficult for some institutions to afford.\n\n### Conclusion\n\nThe integration of technology in education is transforming the way we teach and learn. While there are challenges to be addressed, the benefits far outweigh them. As we move forward, it is essential to ensure that technology is accessible to all students and that educators are equipped with the necessary skills and support to make the most of these innovative tools.\n\nBy embracing technology, we can create a more engaging, inclusive, and efficient educational environment that prepares students for the future.\n",
        "type": "blog_post",
        "title": "The Future of Education: Integrating Technology for Enhanced Learning Experiences",
        "description": "Explore how technology is revolutionizing education, the benefits it brings, and the challenges that need to be addressed.",
        "estimated_reading_time": 10
      }
    ]
  }
];

// Validate the structure using our existing validation logic
function validateStructureMatch(target, response) {
  console.log('🧪 Testing real-world example structure match...');
  
  // Check if arrays have the same length
  if (!Array.isArray(target) || !Array.isArray(response)) {
    console.error('❌ FAILED: Target or response is not an array');
    return false;
  }
  
  if (target.length !== response.length) {
    console.error(`❌ FAILED: Target has ${target.length} items but response has ${response.length} items`);
    return false;
  }
  
  // For each target item, validate against the corresponding response item
  for (let i = 0; i < target.length; i++) {
    const targetItem = target[i];
    const responseItem = response[i];
    
    // Check for contents array
    if (!targetItem.contents || !responseItem.contents) {
      console.error(`❌ FAILED: Item ${i} - contents property is missing`);
      return false;
    }
    
    if (!Array.isArray(targetItem.contents) || !Array.isArray(responseItem.contents)) {
      console.error(`❌ FAILED: Item ${i} - contents is not an array`);
      return false;
    }
    
    if (targetItem.contents.length !== responseItem.contents.length) {
      console.error(`❌ FAILED: Item ${i} - target contents has ${targetItem.contents.length} items but response contents has ${responseItem.contents.length} items`);
      return false;
    }
    
    // For each blog post, validate required properties
    for (let j = 0; j < targetItem.contents.length; j++) {
      const targetContent = targetItem.contents[j];
      const responseContent = responseItem.contents[j];
      
      // Verify required properties
      const requiredProps = ['text', 'type', 'title', 'description', 'estimated_reading_time'];
      for (const prop of requiredProps) {
        if (targetContent[prop] === undefined && responseContent[prop] === undefined) {
          // Both missing the same property - that's fine
          continue;
        }
        
        if (targetContent[prop] === undefined || responseContent[prop] === undefined) {
          console.error(`❌ FAILED: Item ${i}, content ${j} - ${prop} property ${targetContent[prop] === undefined ? 'missing in target' : 'missing in response'}`);
          return false;
        }
        
        // Check types for non-string properties
        if (prop === 'estimated_reading_time' && typeof targetContent[prop] !== typeof responseContent[prop]) {
          console.error(`❌ FAILED: Item ${i}, content ${j} - ${prop} property has different types: ${typeof targetContent[prop]} vs ${typeof responseContent[prop]}`);
          return false;
        }
      }
      
      // Verify that blog_post has real content (not template text)
      if (responseContent.type === 'blog_post') {
        // Check if response text looks like a template
        const placeholders = ['markdown detailed copy', 'title of the content', 'summary of the content'];
        
        let isTemplate = false;
        for (const placeholder of placeholders) {
          if (responseContent.text.includes(placeholder) || 
              responseContent.title.includes(placeholder) || 
              responseContent.description.includes(placeholder)) {
            isTemplate = true;
            console.error(`❌ FAILED: Item ${i}, content ${j} - Contains template text "${placeholder}"`);
            break;
          }
        }
        
        if (isTemplate) {
          return false;
        }
      }
    }
  }
  
  console.log('✅ SUCCESS: Response structure matches target structure!');
  return true;
}

// Test our TargetProcessorAgent implementation with the real case
function validateWithTargetProcessorAgent(target, response) {
  console.log('\n🔍 Simulating TargetProcessorAgent processing...');
  
  // Helper function to check content paths
  function getContentPath(obj) {
    if (obj.contents) return 'contents';
    if (obj.content) return 'content';
    return '';
  }
  
  // Get first item to use in validation
  const targetItem = target[0];
  const responseItem = response[0];
  
  // Get and check content paths
  const targetContentPath = getContentPath(targetItem);
  const responseContentPath = getContentPath(responseItem);
  
  console.log(`Target content path: ${targetContentPath}`);
  console.log(`Response content path: ${responseContentPath}`);
  
  // Check if paths match
  if (targetContentPath !== responseContentPath) {
    console.log('❌ PROBLEM: Content property names do not match');
    console.log('✅ FIX: Rename response property to match target');
    return false;
  }
  
  // Check if target and response are both arrays or not
  const targetIsArray = Array.isArray(targetItem[targetContentPath]);
  const responseIsArray = Array.isArray(responseItem[responseContentPath]);
  
  console.log(`Target content is array: ${targetIsArray}`);
  console.log(`Response content is array: ${responseIsArray}`);
  
  if (targetIsArray && !responseIsArray) {
    console.log('❌ PROBLEM: Target content is array but response content is not');
    console.log('✅ FIX: Wrap response content in array');
    return false;
  }
  
  // If we've got this far, the structure should be correct
  console.log('✅ Target and response structure match correctly');
  
  // Now check content quality
  const targetContent = targetItem[targetContentPath][0];
  const responseContent = responseItem[responseContentPath][0];
  
  // Log the content type
  console.log(`Target content type: ${targetContent.type}`);
  console.log(`Response content type: ${responseContent.type}`);
  
  // Check if the content has been properly processed (not template text)
  if (targetContent.text.includes('markdown detailed') && 
      responseContent.text.includes('markdown detailed')) {
    console.log('❌ PROBLEM: Response contains template text from target');
    return false;
  }
  
  // All checks passed!
  return true;
}

console.log('===== TESTING REAL-WORLD BLOG POST EXAMPLE =====');
console.log('This test validates the exact case provided by the user\n');

// Print structure summary
console.log('Target Structure:');
console.log(JSON.stringify(target[0], null, 2).substring(0, 150) + '...');

console.log('\nResponse Structure:');
console.log(JSON.stringify(response[0], null, 2).substring(0, 150) + '...\n');

// Run validation tests
const basicValidationResult = validateStructureMatch(target, response);
console.log(`\nBasic validation result: ${basicValidationResult ? 'PASS ✅' : 'FAIL ❌'}`);

const agentValidationResult = validateWithTargetProcessorAgent(target, response);
console.log(`\nTarget processor validation result: ${agentValidationResult ? 'PASS ✅' : 'FAIL ❌'}`);

// Final verdict
if (basicValidationResult && agentValidationResult) {
  console.log('\n✅ FINAL VERDICT: This response SHOULD be valid. The fix in TargetProcessorAgent should handle this case correctly.');
  console.log('If this response is still resulting in an empty array, there might be another issue in the validation or database adapter logic.');
} else {
  console.log('\n❌ FINAL VERDICT: This response has structure issues that need to be fixed.');
  console.log('The issues should be addressed by our TargetProcessorAgent fix, but additional validation may be required.');
}

console.log('\n===== DIAGNOSTIC INFORMATION =====');
console.log('The target is expecting an array of objects with "contents" property containing blog posts.');
console.log('The response provides exactly that structure with a properly formatted blog post.');
console.log('If the TargetProcessorAgent is not accepting this, check for additional validation logic that might be rejecting this valid response.'); 