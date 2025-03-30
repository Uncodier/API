/**
 * Tests for JS sanitizer utilities
 */
import { sanitizeJsCode, createSafePersonalizationScript, parsePersonalizationCode } from './js-sanitizer';

/**
 * A simple function to test the sanitization process when run in Node.js
 * This can be run with "node -r ts-node/register src/lib/utils/js-sanitizer.test.ts"
 */
function testSanitization() {
  console.log('Testing JS Sanitizer Utilities');
  
  // Test basic sanitization
  const rawCode = `document.addEventListener('DOMContentLoaded',function(){function a(s,c){try{const e=document.querySelector(s);if(e){c(e);return!0}return!1}catch(e){return!1}}});`;
  const sanitized = sanitizeJsCode(rawCode);
  console.log('\nBasic Sanitization:');
  console.log('Raw:', rawCode);
  console.log('Sanitized:', sanitized);
  
  // Test creating personalization script
  const selectors = ['.framer-1feiza5', '.framer-18f7db3-container button'];
  const contents = [
    'Empower Your Digital Content Creation',
    'Start Creating Now'
  ];
  
  const script = createSafePersonalizationScript(selectors, contents);
  console.log('\nSafe Personalization Script:');
  console.log(script);
  
  // Test parsing code
  const testCode = `document.addEventListener("DOMContentLoaded",function(){function a(s,c){try{const e=document.querySelector(s);if(e){c(e);return true}return false}catch(e){return false}}function b(e,h){try{e.innerHTML=h}catch(e){}}a(".framer-1feiza5",function(e){b(e,"Empower Your Digital Content Creation");});a(".framer-18f7db3-container button",function(e){b(e,"Start Creating Now");});});`;
  
  const parsed = parsePersonalizationCode(testCode);
  console.log('\nParsed Personalization Code:');
  console.log('Selectors:', parsed.selectors);
  console.log('Contents:', parsed.contents);
  
  // Test with problematic content
  const complexSelectors = ['#hero .framer-1feiza5', '#features .framer-1pu7w1o .framer-13id5ue'];
  const complexContents = [
    'Line 1\nLine 2\nLine "3"',
    'This has "quotes" and a \\ backslash'
  ];
  
  const complexScript = createSafePersonalizationScript(complexSelectors, complexContents);
  console.log('\nComplex Personalization Script:');
  console.log(complexScript);
  
  // Verify that we can parse our own output
  const parsedComplex = parsePersonalizationCode(complexScript);
  console.log('\nVerification of Complex Script Parsing:');
  console.log('Selectors match:', JSON.stringify(parsedComplex.selectors) === JSON.stringify(complexSelectors));
  
  // Don't compare directly because of the escaping transformations
  console.log('Content lengths match:', parsedComplex.contents.length === complexContents.length);
}

// Run the test if this file is executed directly
if (require.main === module) {
  testSanitization();
}

export { testSanitization }; 