
const { validateResults } = require('./src/lib/agentbase/agents/targetEvaluator/validateResults.js');

// Mock targets from LeadFollowUpHelper.ts
const refinementTarget = {
  title: "Refined title",
  message: "Refined message",
  channel: "email"
};

const targets = [
  {
    deep_thinking: "Analyze..."
  },
  {
    refined_content: refinementTarget
  }
];

// Case 1: Perfectly matching response (User's example)
const response1 = [
  { deep_thinking: "Thinking..." },
  { 
    refined_content: {
      title: "My Title",
      channel: "email",
      message: "My Message"
    }
  }
];

console.log("--- Case 1: Matching Response ---");
const result1 = validateResults(response1, targets);
console.log("IsValid:", result1.isValid);
if (result1.correctedResults) {
    console.log("Corrected:", JSON.stringify(result1.correctedResults, null, 2));
} else {
    console.log("Original kept.");
}


// Case 2: Flattened response (Common LLM error)
const response2 = [
  { deep_thinking: "Thinking..." },
  { 
    title: "My Title",
    channel: "email",
    message: "My Message"
  }
];

console.log("\n--- Case 2: Flattened Response ---");
const result2 = validateResults(response2, targets);
console.log("IsValid:", result2.isValid);
if (result2.correctedResults) {
    console.log("Corrected:", JSON.stringify(result2.correctedResults, null, 2));
} else {
    console.log("Original kept.");
}

// Case 3: Extra keys in wrapper (User might be seeing this?)
const response3 = [
  { deep_thinking: "Thinking..." },
  { 
    refined_content: {
      title: "My Title",
      channel: "email",
      message: "My Message"
    },
    extra_explanation: "Here is why..."
  }
];

console.log("\n--- Case 3: Extra Keys ---");
const result3 = validateResults(response3, targets);
console.log("IsValid:", result3.isValid);
if (result3.correctedResults) {
    console.log("Corrected:", JSON.stringify(result3.correctedResults, null, 2));
} else {
    console.log("Original kept.");
}
