// Test script with exact test case data
// Run with: node exact_test_case.js

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
        "text": "# Uncodie: Revolutionizing Education with CMO as a Service\n\n## Introduction\nIn the rapidly evolving landscape of education technology, Uncodie stands out as a beacon of innovation. With a unique offering of 'CMO as a Service,' Uncodie is poised to transform how educational institutions approach marketing and technology integration.\n\n## What is Uncodie?\nUncodie is a cutting-edge platform that provides Chief Marketing Officer (CMO) services tailored specifically for the education sector. This service is designed to help educational institutions enhance their marketing strategies, improve engagement, and ultimately drive better educational outcomes.\n\n## Key Features\n- **CMO as a Service**: Uncodie offers a comprehensive suite of marketing services, including strategy development, campaign management, and performance analytics.\n- **Innovative Technology Solutions**: The platform integrates the latest technology to streamline marketing efforts and maximize impact.\n- **Customizable Plans**: Institutions can choose from a variety of service plans to meet their specific needs and budget.\n\n## Target Audience\nUncodie primarily serves educators and institutions focused on integrating innovative technology solutions to enhance learning experiences. This includes schools, colleges, universities, and other educational organizations.\n\n## Competitors\nUncodie faces competition from other education technology providers such as Acme. However, its unique CMO as a Service offering sets it apart in the market.\n\n## Market Analysis\n### Google Ads\n- **Interests**: Educational Technology, Online Learning, School Administration, Innovation in Education\n- **Locations**: United States, Canada, United Kingdom, Australia\n- **Demographics**: Gender (male, female), Age Ranges (25-34, 35-44, 45-54), Parental Status (parent, non-parent), Household Income (top 20%, top 30%)\n- **Geo-Targeting**: Cities (San Francisco, New York, Toronto, London), Regions (California, New York, Ontario, London), Countries (US, CA, UK, AU)\n- **In-Market Segments**: Education Software, Learning Management Systems, Cloud Computing, Business Software\n\n### TikTok Ads\n- **Behaviors**: App installs (Educational tools), Engagement (Educational content), Shopping (Tech accessories), Educational platform participants\n- **Interests**: Educational Technology, Online Learning, Innovation in Education, Tech Gadgets\n- **Languages**: English\n- **Locations**: Cities (San Francisco, New York, Austin, Toronto, London), Regions (California, New York, Texas, Ontario, London), Countries (United States, Canada, United Kingdom, Australia)\n- **Demographics**: Age (25-34, 35-44), Gender (male, female), Location (Urban areas, Educational hubs)\n- **Creator Categories**: Educational Influencers, Tech Educators, Online Learning Advocates, EdTech Innovators\n\n### Facebook Ads\n- **Interests**: Educational technology, Online learning platforms, School administration, Innovation in education\n- **Languages**: English\n- **Locations**: Zips (94103, 10001, 60601, M5V, SW1A), Cities (San Francisco, New York, Chicago, Toronto, London), Regions (California, New York, Texas, Ontario, London), Countries (United States, Canada, United Kingdom, Australia)\n- **Demographics**: Age (25-54), Education (College grad, Master's degree, PhD), Generation (Millennials, Gen X)\n\n### LinkedIn Ads\n- **Job Titles**: Education Technology Specialist, School Administrator, Online Learning Coordinator, Educational Consultant, Instructional Designer\n- **Locations**: Regions (West Coast, East Coast, Midwest, Southeast), Countries (United States, Canada, United Kingdom, Australia), Metropolitan Areas (San Francisco Bay Area, Greater New York City Area, Greater Los Angeles Area)\n- **Industries**: Education Management, Higher Education, E-Learning, Information Technology\n- **Company Size**: 51-200, 201-500, 501-1000\n- **Demographics**: Age (25-34, 35-54), Education (Bachelor's Degree, Master's Degree, PhD), Job Experience (Entry level, Mid-Senior level)\n\n## Conclusion\nUncodie is at the forefront of education technology innovation, offering unparalleled marketing services that cater specifically to the needs of educational institutions. By leveraging advanced technology and a deep understanding of the education sector, Uncodie is set to drive significant improvements in how institutions engage with their audiences and achieve their educational goals.",
        "type": "blog_post",
        "title": "Uncodie: Revolutionizing Education with CMO as a Service",
        "description": "Explore how Uncodie is transforming the education sector with its unique CMO as a Service offering, designed to enhance marketing strategies and improve educational outcomes.",
        "estimated_reading_time": 10
      }
    ]
  }
];

// Debug the structure differences
console.log('=== STRUCTURE COMPARISON ===');
console.log(`Target key: ${Object.keys(target[0])[0]}`);
console.log(`Response key: ${Object.keys(response[0])[0]}`);
console.log(`Target has 'contents' property: ${target[0].hasOwnProperty('contents')}`);
console.log(`Response has 'contents' property: ${response[0].hasOwnProperty('contents')}`);
console.log(`Response has 'type' property: ${response[0].hasOwnProperty('type')}`);
console.log(`Response has 'content' property: ${response[0].hasOwnProperty('content')}`);

// THIS IS THE ROOT ISSUE - different field names in target vs response
console.log('\n=== KEY ISSUE IDENTIFIED ===');
console.log('Target uses "contents" but response uses "type":"contents" with "content" (no s)');
console.log('Target: ', JSON.stringify(target[0]).substring(0, 50) + '...');
console.log('Response: ', JSON.stringify(response[0]).substring(0, 50) + '...');

// Simulate the validation logic
function validateResultsStructure(results, targets) {
  console.log('\n=== SIMULATING VALIDATION ===');

  if (!Array.isArray(results) || !Array.isArray(targets)) {
    console.log('❌ Results or targets are not arrays');
    return false;
  }

  if (results.length !== targets.length) {
    console.log(`❌ Length mismatch: results=${results.length}, targets=${targets.length}`);
    return false;
  }

  // Compare each result with its corresponding target
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const result = results[i];
    
    // Get target type - THIS IS WHERE THE BUG IS
    const targetType = target.type || Object.keys(target)[0];
    console.log(`Target Type detected: "${targetType}"`);
    
    // In the target, the first key is "contents" not "type"
    // But in the result, we have "type":"contents" and "content" array
    console.log(`Result Type: "${result.type}"`);
    
    // ISSUE: This check passes because targetType="contents" and result.type="contents"
    // But the STRUCTURE is different!
    if (result.type !== targetType) {
      console.log(`❌ Type mismatch: result="${result.type}", target="${targetType}"`);
      return false;
    }
    
    // ISSUE: Next we're getting target["contents"] vs result["content"] - different fields
    console.log(`Getting content from target[${targetType}] vs result.content`);
    const targetContent = target[targetType];
    const resultContent = result.content;
    
    // Structural log
    console.log(`Target Content type: ${Array.isArray(targetContent) ? 'array' : typeof targetContent}`);
    console.log(`Result Content type: ${Array.isArray(resultContent) ? 'array' : typeof resultContent}`);
    
    if (!targetContent || !resultContent) {
      console.log('❌ Missing content in target or result');
      return false;
    }
    
    // Check array structure
    if (Array.isArray(targetContent) && Array.isArray(resultContent)) {
      // Here both are arrays with length 1, so this seems fine
      console.log(`Target array length: ${targetContent.length}, Result array length: ${resultContent.length}`);
      
      if (targetContent.length > 0 && resultContent.length > 0) {
        // Check the first blog post
        const targetItem = targetContent[0];
        const resultItem = resultContent[0];
        
        console.log(`\nTarget item type: ${targetItem.type}`);
        console.log(`Result item type: ${resultItem.type}`);
        
        // Check the blog post has required fields
        const requiredFields = ['text', 'type', 'title', 'description', 'estimated_reading_time'];
        let missingFields = [];
        
        for (const field of requiredFields) {
          if (targetItem[field] && !resultItem[field]) {
            missingFields.push(field);
          }
        }
        
        if (missingFields.length > 0) {
          console.log(`❌ Missing fields in result: ${missingFields.join(', ')}`);
          return false;
        }
        
        // Placeholder check
        if (targetItem.text.includes('detailed copy') && resultItem.text.includes('detailed copy')) {
          console.log('❌ Result contains same placeholder text as target');
          return false;
        }
      }
    }
  }

  // If we got here, validation passes
  console.log('✅ Validation passed - THIS IS THE BUG!');
  console.log('It should fail because target.contents ≠ result.content (missing "s")');
  return true;
}

// Fixed validation function that would correctly catch this
function fixedValidation(results, targets) {
  console.log('\n=== FIXED VALIDATION ===');

  if (results.length !== targets.length) {
    return false;
  }

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const result = results[i];
    
    // CRITICAL FIX: We need to check both the property names and values
    // First get ALL keys from both objects to compare structure
    const targetKeys = Object.keys(target);
    const resultKeys = Object.keys(result);
    
    console.log(`Target keys: ${targetKeys.join(', ')}`);
    console.log(`Result keys: ${resultKeys.join(', ')}`);
    
    // Check if structures match before further validation
    // If target has "contents" but result has "type" and "content",
    // these are structurally different, regardless of values
    if (targetKeys.includes('contents') && !resultKeys.includes('contents')) {
      console.log('❌ FIXED: Structural mismatch! Target has "contents" property but result does not');
      return false;
    }
    
    if (resultKeys.includes('type') && !targetKeys.includes('type')) {
      console.log('❌ FIXED: Structural mismatch! Result has "type" property but target does not');
      return false;
    }
    
    // If result has "content" (no s) but target does not, this is a structure mismatch
    if (resultKeys.includes('content') && !targetKeys.includes('content')) {
      console.log('❌ FIXED: Structural mismatch! Result has "content" property but target does not');
      return false;
    }
    
    // Only if structures match, proceed with further validation
    console.log('✅ FIXED: Validation correctly fails on structural mismatch');
    return false;
  }
  
  return true;
}

// Add explicit check for the key issue
console.log('\n=== DIRECT STRUCTURE CHECK ===');
if (target[0].contents && response[0].content && !target[0].content && !response[0].contents) {
  console.log('❌ CRITICAL ISSUE FOUND: Target uses "contents" (with s) but response uses "content" (no s)');
  console.log('This is a structural mismatch that should fail validation!');
}

// Run the validation functions
validateResultsStructure(response, target);
fixedValidation(response, target);

// Solution
console.log('\n=== SOLUTION ===');
console.log('The issue is that the validation logic is too permissive about structure differences.');
console.log('It checks if result.type matches the first key of target ("contents")');
console.log('But it should also verify that the actual structure (property names) match exactly.');
console.log('Fix: Add explicit property name comparison before checking values.'); 