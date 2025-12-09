/**
 * Test script to verify malformed target array detection and correction
 * This tests the new validation logic added to validateResults.js
 */

// Import the validation function
import { validateResults } from './validateResults.js';

console.log('🧪 Testing Malformed Target Array Detection and Correction\n');

// Test Case 1: Malformed structure from user's example
console.log('Test 1: Malformed structure with deep_thinking and refined_content');
const malformedResults1 = [
    {
        "deep_thinking": "El enfoque del sales team ya está bien alineado: email como canal principal..."
    },
    {
        "refined_content": {
            "title": "¿15 min para eliminar el testing manual en tus PRs con E2E autónomos?",
            "channel": "email",
            "message": "Hola Robert,\n\nBugster ejecuta pruebas E2E con IA..."
        }
    }
];

const targets1 = [
    { "deep_thinking": "Analysis of the situation" },
    { "refined_content": { "title": "", "channel": "", "message": "" } }
];

const result1 = validateResults(malformedResults1, targets1);
console.log('Result:', result1);
console.log('Has corrected results:', !!result1.correctedResults);
if (result1.correctedResults) {
    console.log('Corrected results:', JSON.stringify(result1.correctedResults, null, 2));
}
console.log('\n---\n');

// Test Case 2: Valid structure (should not be corrected)
console.log('Test 2: Valid structure (should NOT be corrected)');
const validResults = [
    {
        "title": "Test Email Subject",
        "channel": "email",
        "message": "This is a valid email message"
    }
];

const targets2 = [
    { "title": "", "channel": "", "message": "" }
];

const result2 = validateResults(validResults, targets2);
console.log('Result:', result2);
console.log('Has corrected results:', !!result2.correctedResults);
console.log('\n---\n');

// Test Case 3: Mixed structure with follow_up_content
console.log('Test 3: Malformed structure with follow_up_content');
const malformedResults3 = [
    { "analysis": "Strategic analysis of the lead..." },
    {
        "follow_up_content": {
            "title": "Follow-up Email",
            "channel": "whatsapp",
            "message": "Hi there, following up on our conversation..."
        }
    }
];

const targets3 = [
    { "analysis": "" },
    { "follow_up_content": { "title": "", "channel": "", "message": "" } }
];

const result3 = validateResults(malformedResults3, targets3);
console.log('Result:', result3);
console.log('Has corrected results:', !!result3.correctedResults);
if (result3.correctedResults) {
    console.log('Corrected results:', JSON.stringify(result3.correctedResults, null, 2));
}
console.log('\n---\n');

console.log('✅ All tests completed!');
