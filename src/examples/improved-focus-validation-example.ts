/**
 * EXAMPLE: Focus and Validation Improvements in Prompt Core
 * 
 * This file demonstrates how the implemented improvements simplify
 * computational agent tasks through focus and validation steps.
 */

// BEFORE: Vague plan without validations
const previousPlan = {
  title: "Publish content on LinkedIn",
  steps: [
    {
      title: "Go to LinkedIn",
      description: "Navigate to LinkedIn"
    },
    {
      title: "Create post",
      description: "Create a new post"
    },
    {
      title: "Publish",
      description: "Publish the content"
    }
  ]
};

// AFTER: Plan with improved focus and validation
const improvedPlan = {
  title: "Publish specific content on LinkedIn with complete validation",
  steps: [
    // INITIAL FOCUS STEP
    {
      title: "Focus on content piece: 'Digital Marketing Guide 2024' - locate and open in system",
      description: "Focus work on specific approved content, ignoring other distractions",
      type: "focus",
      estimated_duration_minutes: 1,
      expected_response_type: "step_completed"
    },
    {
      title: "Verify content is approved and ready for publishing",
      description: "Validate that content is in 'approved' status and has all necessary elements",
      type: "validation",
      estimated_duration_minutes: 1,
      expected_response_type: "step_completed"
    },
    {
      title: "Confirm target platform: LinkedIn - navigate to publishing interface",
      description: "Navigate specifically to linkedin.com/feed and confirm access to publishing interface",
      type: "focus",
      estimated_duration_minutes: 2,
      expected_response_type: "step_completed"
    },

    // ACTION STEPS WITH INTEGRATED VALIDATIONS
    {
      title: "Click on 'Start a post' button",
      description: "Click the button to start creating a new post",
      type: "action",
      estimated_duration_minutes: 1,
      expected_response_type: "step_completed"
    },
    {
      title: "Validate post creation dialog opened successfully",
      description: "Confirm that post creation dialog opened correctly and is ready to use",
      type: "validation",
      estimated_duration_minutes: 1,
      expected_response_type: "step_completed"
    },
    {
      title: "Paste approved content into post text area",
      description: "Copy and paste approved content 'Digital Marketing Guide 2024' into text area",
      type: "action",
      estimated_duration_minutes: 2,
      expected_response_type: "step_completed"
    },
    {
      title: "Confirm content appears correctly formatted in preview",
      description: "Verify that content displays correctly formatted in preview",
      type: "validation",
      estimated_duration_minutes: 1,
      expected_response_type: "step_completed"
    },
    {
      title: "Click 'Post' to publish",
      description: "Click the 'Post' button to publish the content",
      type: "action",
      estimated_duration_minutes: 1,
      expected_response_type: "step_completed"
    },

    // FINAL VERIFICATION STEPS
    {
      title: "Validate post appears in company feed and is publicly visible",
      description: "Confirm that post appears in company feed and is publicly visible",
      type: "verification",
      estimated_duration_minutes: 2,
      expected_response_type: "step_completed"
    },
    {
      title: "Refresh page to confirm post is persistent and properly saved",
      description: "Reload page to verify that post was saved correctly and is persistent",
      type: "verification",
      estimated_duration_minutes: 1,
      expected_response_type: "step_completed"
    }
  ]
};

/**
 * BENEFITS OF THE IMPROVEMENTS:
 * 
 * 1. CLEAR FOCUS:
 *    - Each plan starts with steps that focus attention on the specific objective
 *    - Eliminates ambiguity about what content/platform to use
 *    - Agent knows exactly what to concentrate on
 * 
 * 2. CONTINUOUS VALIDATION:
 *    - Validation checkpoints after each important action
 *    - Verification that each step completed correctly before continuing
 *    - Early detection of problems before they accumulate
 * 
 * 3. FINAL VERIFICATION:
 *    - Specific steps to confirm the final result is correct
 *    - Persistence validation (reload page, navigate and return)
 *    - Confirmation that the original objective was met
 * 
 * 4. AGENT SIMPLIFICATION:
 *    - Each step is specific and executable in 1-4 minutes
 *    - No ambiguity about what to do at each moment
 *    - Agent can validate its progress at each step
 *    - Reduces errors from assuming something worked without verification
 */

export const focusValidationExample = {
  previousPlan,
  improvedPlan,
  benefits: [
    "Clear focus on specific objectives",
    "Continuous progress validation",
    "Final result verification",
    "Complex task simplification",
    "Reduction of assumption-based errors"
  ]
};
