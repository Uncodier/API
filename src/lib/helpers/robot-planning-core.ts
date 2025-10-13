import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeRobotActivityPlanning } from '@/lib/helpers/campaign-commands';

// ------------------------------------------------------------------------------------
// Core Activity Context and Instructions Builder
// ------------------------------------------------------------------------------------

export interface ActivityContext {
  additionalContext: string;
  specificInstructions: string;
  requiredData: string[];
}

export interface PlanDecision {
  action: 'continue_plan' | 'modify_plan' | 'new_plan';
  reason: string;
  shouldRegeneratePlan: boolean;
}

/**
 * Core function to get activity-specific context with comprehensive instructions
 * This is the shared core that both growth plan and instance act routes use
 */
export async function getActivitySpecificContext(
  activityType: string, 
  siteId: string,
  userContext?: string,
  previousPlanContext?: string
): Promise<ActivityContext> {
  const activityTypeNormalized = activityType.toLowerCase().trim();
  
  // Base context with user input and previous plan context if provided
  const baseContext = [
    userContext ? `\n🎯 USER CONTEXT:\n${userContext}\n` : '',
    previousPlanContext ? `\n📋 PREVIOUS PLAN CONTEXT:\n${previousPlanContext}\n` : ''
  ].filter(Boolean).join('');
  
  switch (activityTypeNormalized) {
    case 'free agent':
    case 'free-agent':
      // Get the latest available authentication sessions
      const { data: recentSessions } = await supabaseAdmin
        .from('automation_auth_sessions')
        .select('id, name, domain, auth_type, last_used_at, usage_count, created_at')
        .eq('site_id', siteId)
        .eq('is_valid', true)
        .order('last_used_at', { ascending: false })
        .limit(10);

      // ✅ CORRECTED LOGIC: Free Agent mode can work with or without sessions
      // If there are sessions, include them in context. If not, the agent will work without them.
      const sessionsContext = (!recentSessions || recentSessions.length === 0) 
        ? `\n⚠️ NO SESSIONS AVAILABLE:\nNo authentication sessions are currently available. The agent will work in limited mode without access to authenticated platforms.\n`
        : `\n🔑 AVAILABLE SESSIONS (${recentSessions.length} sessions):\n` +
          recentSessions.map((session, index) => 
            `${index + 1}. **${session.name}** (${session.domain})\n` +
            `   Session ID: ${session.id}\n` +
            `   Type: ${session.auth_type}\n` +
            `   Last used: ${session.last_used_at ? new Date(session.last_used_at).toLocaleString() : 'Never used'}\n` +
            `   Usage count: ${session.usage_count || 0}\n`
          ).join('\n');

      return {
        additionalContext: baseContext + sessionsContext,
        specificInstructions: `
🤖 FREE AGENT MODE - GOOGLE NAVIGATION ONLY:

⚠️ IMPORTANT CONTEXT: Este agente está configurado específicamente para navegar únicamente a Google y realizar tareas relacionadas.

Create a SIMPLE plan focused exclusively on Google navigation and tasks.

🔧 MANDATORY STEP DECOMPOSITION:
Break down ALL tasks into specific, executable browser actions:

✅ GOOD STEP EXAMPLES:
- "Open Chrome browser"
- "Navigate to google.com"
- "Click on the search bar"
- "Type '[search query]' in the search field"
- "Press Enter to search"
- "Click on the first search result"
- "Scroll down to read more content"

❌ AVOID VAGUE STEPS:
- "Search for information" (too vague)
- "Research the topic" (not specific)
- "Find relevant content" (not actionable)

🎯 BASIC OBJECTIVES:
- Navigate ONLY to Google (google.com)
- Perform basic Google searches with specific steps
- Use Google services (Search, News, etc.)
- Maximum 3-5 simple, specific steps
- No other websites or platforms allowed

📋 SIMPLE PLAN STRUCTURE:
1. Open web browser and navigate to Google.com
2. Click on the search bar at the top of the page
3. Type specific search query related to the user's business/industry
4. Press Enter to execute the search
5. Click on the first relevant search result to review

🔍 BASIC REQUIREMENTS:
- ONLY navigate to google.com and its subdomains (news.google.com, etc.)
- Create simple, direct navigation steps with specific actions
- No authentication required for basic Google searches
- Maximum 30-minute execution time total
- Focus on information gathering through Google search

⚠️ STRICT RESTRICTIONS:
- Do NOT navigate to any website other than Google
- Do NOT access social media platforms
- Do NOT use any authentication sessions
- Do NOT create complex workflows
- Do NOT suggest visiting other websites
- ONLY use Google's public search functionality

${userContext ? `\n⚠️ ADDITIONAL CONTEXT: Incorporate the following context in all decisions:\n${userContext}\n` : ''}`,
        requiredData: ['search_terms']
      };

    case 'channel market fit':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🎯 CHANNEL MARKET FIT FOCUS:
- VALIDATE existing customer segments by checking actual user behavior data
- Test and validate channel effectiveness for current customer base
- Focus on ONE channel that shows highest engagement/conversion potential
- Use existing customer data to validate channel-market alignment
- Prioritize channels where customers are already active

🔍 VALIDATION REQUIREMENTS:
- Verify customer segment data exists and is current (not outdated)
- Check if engagement metrics are accurate and recent
- Validate channel performance data against actual platform analytics
- If data is missing or outdated, include steps to gather current information

${userContext ? `\n⚠️ ADDITIONAL CONTEXT: Incorporate the following context in all decisions:\n${userContext}\n` : ''}`,
        requiredData: ['segments', 'customer_behavior', 'channel_performance']
      };

    case 'engage in social networks':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🌐 SOCIAL NETWORKS ENGAGEMENT FOCUS:
- Select ONE primary social platform based on customer segments
- Focus on existing follower engagement over new acquisition
- Use approved content pieces for social interactions
- Prioritize platforms where previous sessions exist for authentication
- Create simple engagement actions: reply, share, post using existing content

🔧 MANDATORY STEP DECOMPOSITION FOR SOCIAL ENGAGEMENT:
Break down ALL social media tasks into specific browser actions:

✅ GOOD STEP EXAMPLES:
- "Navigate to linkedin.com"
- "Click on the search bar at the top"
- "Type 'target user name' in search field"
- "Press Enter to search"
- "Click on the first profile result"
- "Scroll down to view recent posts"
- "Click on the first post to open it"
- "Click the 'Like' button below the post"
- "Click the 'Comment' button"
- "Type a positive comment in the comment field"
- "Click 'Post' to submit the comment"

❌ AVOID VAGUE SOCIAL STEPS:
- "Engage with followers" (too vague)
- "Create social presence" (not specific)
- "Build relationships" (not actionable)
- "Interact with content" (not specific enough)

🔍 VALIDATION REQUIREMENTS:
- VERIFY authentication sessions are still active and valid
- Check if social profiles/pages exist and are accessible
- Validate that approved content is actually published and visible
- Confirm follower counts and engagement metrics are current
- If posts appear published in system but aren't visible online, recreate them
- Verify social platform API access and permissions before executing actions

🎯 MANDATORY SOCIAL MEDIA FOCUS AND VALIDATION STEPS:
ALWAYS include these step types in your social engagement plan:

FOCUS STEPS (at start):
1. "Focus on platform: [specific social platform] - navigate to main interface"
2. "Verify authentication session is active and profile is accessible"
3. "Confirm target audience/content for engagement is identified"

VALIDATION CHECKPOINTS (throughout):
- "Validate platform loaded correctly and user is logged in"
- "Confirm target profiles/posts are accessible and current"
- "Verify engagement actions (likes, comments, shares) are working"
- "Check that interactions are being recorded and visible"

VERIFICATION STEPS (at end):
- "Validate all engagement actions were completed successfully"
- "Confirm interactions appear in activity feed and are public"
- "Verify engagement metrics updated correctly in analytics"

${userContext ? `\n⚠️ ADDITIONAL CONTEXT: Incorporate the following context in all decisions:\n${userContext}\n` : ''}`,
        requiredData: ['approved_content', 'social_sessions', 'segments']
      };

    case 'seo':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🔍 SEO OPTIMIZATION FOCUS:
- Focus on ONE specific keyword or content piece optimization
- Use existing approved content as foundation for SEO improvements
- Prioritize on-page optimization over technical SEO changes
- Target low-hanging fruit: meta descriptions, title tags, content updates
- Measure through simple ranking/traffic monitoring

🔍 VALIDATION REQUIREMENTS:
- VERIFY content is actually live and indexed by search engines
- Check current keyword rankings using real-time SEO tools
- Validate that meta tags and descriptions match what's actually on the website
- Confirm content updates are properly deployed and visible online
- If system shows content as optimized but SEO tools show otherwise, re-implement changes
- Test website accessibility and loading speed before claiming SEO completion

🎯 MANDATORY SEO FOCUS AND VALIDATION STEPS:
ALWAYS include these step types in your SEO optimization plan:

FOCUS STEPS (at start):
1. "Focus on target page/content: [specific URL] - navigate and load page"
2. "Verify page loads correctly and content is accessible"
3. "Confirm target keyword: [keyword] - identify optimization opportunities"

VALIDATION CHECKPOINTS (throughout):
- "Validate page source shows updated meta tags correctly"
- "Confirm content changes are visible in browser and saved"
- "Verify keyword density and placement are optimized"
- "Check that internal/external links are working properly"

VERIFICATION STEPS (at end):
- "Validate page is indexed by search engines (site:domain.com check)"
- "Confirm SEO changes are reflected in page source code"
- "Verify page loading speed and accessibility scores improved"

${userContext ? `\n⚠️ ADDITIONAL CONTEXT: Incorporate the following context in all decisions:\n${userContext}\n` : ''}`,
        requiredData: ['approved_content', 'current_rankings', 'target_keywords']
      };

    case 'publish content':
      const { data: approvedContent } = await supabaseAdmin
        .from('contents')
        .select('id, title, description, type, status, campaign_id')
        .eq('site_id', siteId)
        .in('status', ['approved', 'ready'])
        .order('created_at', { ascending: false })
        .limit(10);

      const contentContext = approvedContent && approvedContent.length > 0
        ? `\n📄 APPROVED CONTENT AVAILABLE (${approvedContent.length} items):\n` +
          approvedContent.map((content, index) => 
            `${index + 1}. **${content.title}** (${content.type})\n` +
            `   Description: ${content.description || 'No description'}\n` +
            `   Status: ${content.status}\n` +
            (content.campaign_id ? `   Campaign ID: ${content.campaign_id}\n` : '')
          ).join('\n')
        : '\n⚠️ No approved content found - focus on content preparation steps\n';

      return {
        additionalContext: baseContext + contentContext,
        specificInstructions: `
📝 CONTENT PUBLISHING FOCUS:
- Use ONLY approved content from the list above
- Select ONE content piece for publishing
- Choose ONE platform/channel for publishing
- Focus on proper formatting and scheduling for maximum impact
- Ensure content aligns with existing campaigns if campaign_id is present

🔧 MANDATORY STEP DECOMPOSITION FOR CONTENT PUBLISHING:
Break down ALL publishing tasks into specific browser actions:

✅ GOOD STEP EXAMPLES:
- "Navigate to facebook.com/pages"
- "Click on 'Create Post' button"
- "Click in the post text area"
- "Copy approved content text from system"
- "Paste content into the post text area"
- "Click 'Add Photo/Video' if content includes media"
- "Select and upload the content image"
- "Click 'Schedule' button to set publish time"
- "Select date and time for publishing"
- "Click 'Schedule Post' to confirm"

❌ AVOID VAGUE PUBLISHING STEPS:
- "Publish content" (too vague)
- "Share on social media" (not specific)
- "Create marketing post" (not actionable)
- "Distribute content" (not specific enough)

🔍 VALIDATION REQUIREMENTS:
- VERIFY content piece actually exists and is accessible in the system
- Check if content is already published online - if system shows "published" but content isn't visible, republish it
- Validate publishing platform credentials and access permissions
- Confirm content formatting displays correctly on target platform
- If scheduled posts don't appear as expected, recreate the publishing process
- Test all links, images, and media in content before marking as published
- Verify content appears in correct campaign/section if associated with campaign_id

🎯 MANDATORY CONTENT FOCUS AND VALIDATION STEPS:
ALWAYS include these step types in your content publishing plan:

FOCUS STEPS (at start):
1. "Focus on content piece: [specific title] - locate and open in system"
2. "Verify content is approved and ready for publishing"
3. "Confirm target platform: [platform] - navigate to publishing interface"

VALIDATION CHECKPOINTS (throughout):
- "Validate content loaded correctly in publishing interface"
- "Confirm all media/images are properly attached and visible"
- "Verify content formatting appears correctly in preview"
- "Check scheduling settings are configured as intended"

VERIFICATION STEPS (at end):
- "Validate published content is live and publicly accessible"
- "Confirm content appears in correct feed/section"
- "Verify all links and media work correctly in published version"

${userContext ? `\n⚠️ ADDITIONAL CONTEXT: Incorporate the following context in all decisions:\n${userContext}\n` : ''}`,
        requiredData: ['approved_content', 'publishing_channels', 'scheduling_preferences']
      };

    case 'publish ads':
      const { data: activeCampaigns } = await supabaseAdmin
        .from('campaigns')
        .select('id, title, description, status, budget, target_audience')
        .eq('site_id', siteId)
        .in('status', ['active', 'pending'])
        .order('created_at', { ascending: false })
        .limit(10);

      const campaignsContext = activeCampaigns && activeCampaigns.length > 0
        ? `\n🎯 ACTIVE CAMPAIGNS AVAILABLE (${activeCampaigns.length} campaigns):\n` +
          activeCampaigns.map((campaign, index) => 
            `${index + 1}. **${campaign.title}** (${campaign.status})\n` +
            `   Description: ${campaign.description || 'No description'}\n` +
            `   Budget: ${campaign.budget || 'Not specified'}\n` +
            `   Target Audience: ${campaign.target_audience || 'Not specified'}\n`
          ).join('\n')
        : '\n⚠️ No active campaigns found - focus on campaign setup steps\n';

      return {
        additionalContext: baseContext + campaignsContext,
        specificInstructions: `
💰 AD PUBLISHING FOCUS:
- Use ONLY existing campaigns from the list above
- Select ONE campaign for ad publishing
- Focus on ONE advertising platform (Google Ads, Facebook, LinkedIn)
- Use existing campaign budget and targeting parameters
- Create simple ad variations using approved content

🔍 VALIDATION REQUIREMENTS:
- VERIFY campaign actually exists and is active on the advertising platform
- Check if ads are already running - if system shows "active" but platform shows "paused/stopped", reactivate them
- Validate advertising account access and billing status
- Confirm campaign budget limits and spending are accurate
- If ads appear created but aren't serving, troubleshoot and recreate them
- Verify target audience settings match between system and platform
- Test ad creative displays correctly before launching

${userContext ? `\n⚠️ ADDITIONAL CONTEXT: Incorporate the following context in all decisions:\n${userContext}\n` : ''}`,
        requiredData: ['active_campaigns', 'ad_platforms', 'campaign_budgets']
      };

    case 'ux analysis':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🎨 UX ANALYSIS FOCUS:
- Focus on ONE specific page or user flow
- Use existing customer journey data and segments
- Prioritize high-traffic pages or conversion bottlenecks
- Create actionable UX improvement recommendations
- Focus on quick wins: loading speed, navigation, conversion elements

🔍 VALIDATION REQUIREMENTS:
- VERIFY website pages are accessible and loading correctly
- Check if analytics data reflects current user behavior (not outdated)
- Validate conversion tracking is working and recording accurate data
- Confirm user flow paths exist and function as expected
- If heat maps or user session recordings show different behavior than data suggests, investigate discrepancies
- Test all interactive elements and forms before analyzing their performance
- Verify A/B tests are running correctly if system shows them as active

${userContext ? `\n⚠️ ADDITIONAL CONTEXT: Incorporate the following context in all decisions:\n${userContext}\n` : ''}`,
        requiredData: ['user_behavior', 'conversion_data', 'page_performance']
      };

    case 'build requirements':
      const { data: pendingRequirements } = await supabaseAdmin
        .from('requirements')
        .select('id, title, description, priority, status, type, estimated_cost')
        .eq('site_id', siteId)
        .in('status', ['pending', 'validated', 'in-progress'])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(15);

      const requirementsContext = pendingRequirements && pendingRequirements.length > 0
        ? `\n📋 PENDING REQUIREMENTS (${pendingRequirements.length} items):\n` +
          pendingRequirements.map((req, index) => 
            `${index + 1}. **${req.title}** (${req.status}, ${req.priority || 'medium'} priority)\n` +
            `   Description: ${req.description || 'No description'}\n` +
            `   Type: ${req.type || 'general'}\n` +
            `   Estimated Cost: ${req.estimated_cost ? '$' + req.estimated_cost : 'Not specified'}\n`
          ).join('\n')
        : '\n⚠️ No pending requirements found - focus on requirement gathering\n';

      return {
        additionalContext: baseContext + requirementsContext,
        specificInstructions: `
📋 BUILD REQUIREMENTS FOCUS:
- Review and prioritize existing pending requirements from the list above
- Select the HIGHEST priority requirement for detailed breakdown
- Create actionable sub-tasks and implementation steps
- Focus on requirements that align with current campaigns and content
- Estimate realistic timelines and resource needs

🔍 VALIDATION REQUIREMENTS:
- VERIFY requirements are still relevant and haven't been completed elsewhere
- Check if similar functionality already exists in the system
- Validate estimated costs and timelines against current market rates
- Confirm stakeholder needs haven't changed since requirement creation
- If requirements appear to conflict with existing features, investigate and resolve conflicts
- Verify technical feasibility before committing to implementation plans
- Check if requirements dependencies are actually available and working

${userContext ? `\n⚠️ ADDITIONAL CONTEXT: Incorporate the following context in all decisions:\n${userContext}\n` : ''}`,
        requiredData: ['pending_requirements', 'current_resources', 'priority_matrix']
      };

    case 'robot':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🤖 ROBOT ACTIVITY MODE:
- Goal: Execute user-specified robot task with message and context guidance.
- Create a flexible plan based on the user's message and additional context.
- Allow more flexibility than free agent but maintain simplicity.
- Can execute commands and use authentication sessions when needed.

🔧 MANDATORY STEP DECOMPOSITION:
Break down the user's message into specific, executable browser actions:

✅ GOOD STEP EXAMPLES:
- "Navigate to [specific website]"
- "Click on [specific element]"
- "Type '[specific text]' in [specific field]"
- "Press Enter to [specific action]"
- "Scroll to [specific section]"
- "Upload [specific file] to [specific location]"

❌ AVOID VAGUE STEPS:
- "Complete the task" (too vague)
- "Handle the request" (not specific)
- "Process the information" (not actionable)

🎯 ROBOT ACTIVITY OBJECTIVES:
- Execute the specific task described in the user's message
- Use provided context to enhance task execution
- Navigate to appropriate platforms based on task requirements
- Complete task within 1-2 hours maximum
- Use authentication sessions if available and needed

📋 FLEXIBLE PLAN STRUCTURE:
1. Analyze the user's message and context
2. Navigate to appropriate platform/website
3. Execute specific actions based on message requirements
4. Validate completion of the requested task
5. Save any relevant data or sessions

🔍 BASIC REQUIREMENTS:
- Create steps based on the specific user message
- Use context information to enhance task execution
- Maximum 5-8 steps total
- Each step should be completable within 4 minutes
- Focus on the exact task described in the message

⚠️ CONTEXT INTEGRATION:
- Incorporate user message as the primary task instruction
- Use additional context to refine and enhance the plan
- Adapt plan complexity based on message requirements

${userContext ? `\n⚠️ USER MESSAGE AND CONTEXT:\n${userContext}\n` : ''}`,
        requiredData: ['user_message', 'task_context']
      };

    case 'ask':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🗣️ ASK MODE (Quick Q&A):
- Goal: Answer a specific question quickly using reputable sources.
- Keep it simple: 3–5 short steps, total time ≤ 30 minutes.
- Prefer a single channel: Web search (DuckDuckGo/Google) or internal docs if relevant.
- Always cite and validate the source of the answer.
 - If the answer is already known, provide it directly without browsing.

🔧 Step decomposition (examples):
- "Navigate to duckduckgo.com"
- "Type '[question keywords]' in the search field"
- "Open the first reputable result (docs, gov, edu, recognized vendor)"
- "Locate the exact answer, extract key facts"
- "Summarize the answer in 1–3 sentences and capture the source URL"

✅ Validation:
- Verify the page loaded and is accessible.
- Check the source credibility; avoid low-quality or AI-generated pages.
- Confirm the extracted answer matches the question intent.
- Include the source URL in the final verification step.

${userContext ? `\n⚠️ ADDITIONAL CONTEXT:\n${userContext}\n` : ''}`,
        requiredData: ['question', 'context_sources']
      };

    case 'deep research':
    case 'deep-research':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🕵️ DEEP RESEARCH MODE (Multi-source synthesis):
- Goal: Conduct thorough research on a single topic and synthesize findings.
- Use multiple credible sources; include at least one primary or standards/documentation source when possible.
- Include exploration steps to discover tools/sections and refine queries.
- Timebox the effort (e.g., 60–120 minutes), break into short actionable steps.

🔧 Phase guidance:
1) Scoping & Query Refinement:
- "Navigate to duckduckgo.com"
- "Search for '[topic] overview' to identify 2–3 authoritative sources"
- "Refine queries for subtopics (definitions, metrics, trade-offs, recent changes)"

2) Evidence Collection:
- "Open source A (docs/standard/peer-reviewed) and collect key facts"
- "Open source B (recognized vendor/blog) and note differences and dates"
- "Capture URLs, publication dates, and relevant quotes"

3) Synthesis & Gaps:
- "List convergences/divergences across sources"
- "Identify gaps or uncertainties requiring follow-up"
- "Draft a concise summary with citations"

✅ Validation:
- Verify sources are accessible and reputable (docs/standards, gov/edu, established vendors).
- Check publication/update dates to avoid stale information.
- Cross-check key claims across at least two sources.
- Ensure final summary includes explicit citations/links.

${userContext ? `\n⚠️ ADDITIONAL CONTEXT:\n${userContext}\n` : ''}`,
        requiredData: ['research_goal', 'candidate_sources', 'timebox_minutes']
      };

    default:
      return {
        additionalContext: baseContext,
        specificInstructions: `
🤖 CONTEXTUALIZED PLAN:
- Consider the specific context provided by the user
- Create plan focused on expressed needs
- Maintain simplicity and efficiency in execution
- Maximum 3-5 main steps
- Maximum execution time: 2 hours

🔄 GENERAL ACTIVITY FOCUS:
- Focus on ONE specific action within the activity scope
- Use existing campaigns and content as foundation
- Prioritize quick wins and measurable outcomes
- Align with current customer journey stage

🔍 VALIDATION REQUIREMENTS:
- ALWAYS verify system data matches reality before executing actions
- Check if claimed "completed" or "published" items actually exist and are visible
- Validate authentication and access to platforms before proceeding
- If discrepancies found between system and reality, include steps to fix them
- Test all functionality before marking activities as complete
- Verify that all actions are viable with available resources
- Confirm that the plan aligns with the provided context
- Ensure that each step is executable within the estimated time

🎯 MANDATORY GENERAL FOCUS AND VALIDATION STEPS:
For ANY activity type, ALWAYS include these step patterns:

FOCUS STEPS (at start):
1. "Focus on primary objective: [specific goal] - identify exact target"
2. "Verify all required resources/data are available and accessible"
3. "Confirm working environment is ready for task execution"

VALIDATION CHECKPOINTS (throughout):
- "Validate each action completed successfully before proceeding"
- "Confirm data/content changes are saved and persistent"
- "Verify system responses match expected outcomes"
- "Check that progress aligns with original objective"

VERIFICATION STEPS (at end):
- "Validate final outcome matches the intended goal"
- "Confirm all changes are persistent and properly saved"
- "Verify task completion can be independently verified"

${userContext ? `\n⚠️ ADDITIONAL CONTEXT: Incorporate the following context in all decisions:\n${userContext}\n` : ''}`,
        requiredData: ['general_context', 'user_context', 'activity_type']
      };
  }
}

/**
 * Core function to decide what action to take with existing plans using AI
 */
export async function decidePlanAction(
  currentPlan: any | null,
  userMessage: string,
  userContext?: string,
  siteId?: string,
  userId?: string
): Promise<PlanDecision> {
  // If there's no current plan, create a new one
  if (!currentPlan) {
    return {
      action: 'new_plan',
      reason: 'No active plan exists, generating new plan',
      shouldRegeneratePlan: true
    };
  }

  // If the plan is completed or failed, generate new plan
  if (['completed', 'failed'].includes(currentPlan.status)) {
    return {
      action: 'new_plan',
      reason: `Previous plan ${currentPlan.status}, executing workflow and generating new plan`,
      shouldRegeneratePlan: true
    };
  }

  // Use AI to decide what to do with the plan (even with steps in_progress)
  try {
    const aiDecision = await decideWithAI(currentPlan, userMessage, userContext, siteId, userId);
    return aiDecision;
  } catch (error) {
    console.error('Error in AI decision, using fallback logic:', error);
    
    // Fallback to simple logic if AI fails
    const userText = (userMessage + ' ' + (userContext || '')).toLowerCase();
    
    // Check if there are steps in_progress as critical fallback rule
    const steps = currentPlan.steps || [];
    const inProgressStep = steps.find((step: any) => step.status === 'in_progress');
    
    // Explicit keywords for new plan
  const regenerationKeywords = [
    'nuevo plan', 'new plan', 'cambiar plan', 'change plan',
    'diferente plan', 'otro plan', 'plan diferente',
    'empezar de nuevo', 'start over', 'reiniciar'
  ];
  
    if (regenerationKeywords.some(keyword => userText.includes(keyword))) {
    return {
      action: 'new_plan',
        reason: 'User explicitly requests a new plan (fallback)',
      shouldRegeneratePlan: true
    };
  }

    // If there's a step in_progress, continue by default (conservative fallback)
    if (inProgressStep) {
      return {
        action: 'continue_plan',
        reason: `There's a step in progress (${inProgressStep.title}), continuing current plan (fallback)`,
        shouldRegeneratePlan: false
      };
    }

    // By default, continue with current plan
    return {
      action: 'continue_plan',
      reason: 'Continuing with existing active plan (fallback)',
      shouldRegeneratePlan: false
    };
  }
}

/**
 * Use AI to intelligently decide what to do with the current plan
 */
async function decideWithAI(
  currentPlan: any,
  userMessage: string,
  userContext?: string,
  siteId?: string,
  userId?: string
): Promise<PlanDecision> {
  const { ProcessorInitializer } = await import('@/lib/agentbase/services/processor/ProcessorInitializer');
  const { CommandFactory } = await import('@/lib/agentbase/services/command/CommandFactory');
  const { waitForCommandCompletion } = await import('@/lib/helpers/command-utils');

  // Prepare current plan context
  let planContext = `CURRENT PLAN:
Title: ${currentPlan.title}
Status: ${currentPlan.status}
Description: ${currentPlan.description || 'No description'}
Progress: ${currentPlan.steps_completed || 0}/${currentPlan.steps_total || 0} steps completed`;

  // Identify steps in_progress
  const steps = currentPlan.steps || [];
  const inProgressSteps = steps.filter((step: any) => step.status === 'in_progress');
  
  if (inProgressSteps.length > 0) {
    planContext += `\n\n⚠️ IMPORTANT: There are ${inProgressSteps.length} step(s) IN PROGRESS:`;
    inProgressSteps.forEach((step: any, index: number) => {
      planContext += `\n- ${step.title} (IN PROGRESS)`;
      if (step.description) {
        planContext += ` - ${step.description}`;
      }
    });
  }

  if (currentPlan.steps && currentPlan.steps.length > 0) {
    planContext += `\n\nALL STEPS:`;
    currentPlan.steps.forEach((step: any, index: number) => {
      const statusEmoji = step.status === 'in_progress' ? '🔄' : 
                         step.status === 'completed' ? '✅' : 
                         step.status === 'failed' ? '❌' : '⏳';
      planContext += `\n${index + 1}. ${statusEmoji} ${step.title} (${step.status})`;
      if (step.description) {
        planContext += ` - ${step.description}`;
      }
    });
  }

  const fullContext = `${planContext}

USER MESSAGE: ${userMessage}

${userContext ? `ADDITIONAL CONTEXT: ${userContext}` : ''}

Analyze the user message in the context of the current plan and decide what action to take.

IMPORTANT: ALWAYS BREAK DOWN TASKS INTO SIMPLE AND EXECUTABLE STEPS
- Each step should be a specific action that the robot can execute in 1-4 minutes
- Divide complex tasks into multiple sequential steps
- Each step should have a clear and measurable objective
- Use specific action verbs: "Navigate to", "Click on", "Write", "Search", "Select"
- Avoid vague steps like "Research" or "Analyze" - be specific about WHAT and HOW

🎯 MANDATORY FOCUS AND VALIDATION PATTERN:
EVERY plan MUST follow this pattern to simplify agent execution:

STEP 1 - ALWAYS START WITH FOCUS:
- "Focus on [specific target] - navigate to exact URL/location"
- "Verify [target] loaded correctly and is accessible"
- "Confirm we are working with the correct [item/content/page]"

THROUGHOUT PLAN - ADD VALIDATION CHECKPOINTS:
- After navigation: "Validate page loaded successfully"
- After clicks: "Confirm [element] responded as expected" 
- After data entry: "Verify [data] was entered correctly"
- After saves: "Check [content] was saved successfully"

FINAL STEP - ALWAYS END WITH VERIFICATION:
- "Validate final result is visible and correct"
- "Confirm all changes are persistent and saved"
- "Verify task completion meets the original objective"

DECOMPOSITION EXAMPLES:
❌ Bad: "Search for information about Santiago Zavala on LinkedIn"
✅ Good: 
  1. "Navigate to linkedin.com"
  2. "Click on the search bar"
  3. "Type 'Santiago Zavala' in the search field"
  4. "Press Enter to search"
  5. "Review the first 3 search results"
  6. "Click on the most relevant profile"

AVAILABLE OPTIONS:
1. "continue_plan" - Continue with current plan by adding the message as a new step
2. "modify_plan" - Modify existing plan keeping some elements but regenerating with new context
3. "new_plan" - Create a completely new plan ignoring the current plan

CRITICAL DECISION CRITERIA:

🔄 USE "continue_plan" ONLY when:
- User is reporting progress/results from existing steps
- User wants to add a step VERY RELATED to the current plan objective
- Message is a status update or confirmation
- User is responding to a question from the current plan

🔧 USE "modify_plan" when:
- User wants to change direction but maintain general context
- Wants to adjust existing plan with new requirements
- Objective is similar but with important modifications

🆕 USE "new_plan" when:
- User requests to do something COMPLETELY DIFFERENT from current plan
- New objective has no relation to the plan in progress
- Wants to start a new task even if there are steps in progress
- Message describes a new and independent activity

SPECIAL RULES FOR STEPS IN PROGRESS:
- If there are steps in progress but user wants to do something UNRELATED → new_plan
- If user wants to do something that requires interrupting current steps → new_plan
- Only continue if message is directly related to steps in progress

EXAMPLES:
- "Navigate to LinkedIn" when current plan is "Open DuckDuckGo" → new_plan (different activity)
- "I finished step 1" when there are steps in progress → continue_plan (progress report)
- "Change search to Google" when in DuckDuckGo → modify_plan (same type, different platform)

Respond ONLY with the JSON in this exact format:
{
  "action": "continue_plan|modify_plan|new_plan",
  "reason": "Clear explanation of why you made this decision",
  "shouldRegeneratePlan": true|false
}`;

  // Initialize command system
  const processorInitializer = ProcessorInitializer.getInstance();
  processorInitializer.initialize();
  const commandService = processorInitializer.getCommandService();

  // Create command for AI decision
  const command = CommandFactory.createCommand({
    task: 'plan decision analysis',
    userId: userId || siteId || '00000000-0000-0000-0000-000000000000', // Use userId, then siteId as fallback, or default UUID
    agentId: 'tool_evaluator', // Use tool evaluator for decisions
    description: 'Analyze user message and current plan to decide the best action',
    context: fullContext,
    targets: [{
      plan_decision: {
        action: "continue_plan|modify_plan|new_plan",
        reason: "explanation",
        shouldRegeneratePlan: true
      }
    }],
    tools: [], // Explicitly no tools - text analysis only
    model: 'gpt-5-mini',
    modelType: 'openai',
    responseFormat: 'json'
  });

  // Execute command
  const commandId = await commandService.submitCommand(command);
  
  // Wait for result with short timeout (maximum 30 seconds)
  const { command: completedCommand, completed } = await waitForCommandCompletion(commandId, 15, 2000);

  if (!completed || !completedCommand?.results) {
    throw new Error('AI decision command did not complete successfully');
  }

  // Extract decision from result
  let aiDecision = null;
  
  if (completedCommand.results && Array.isArray(completedCommand.results)) {
    for (const result of completedCommand.results) {
      if (result.plan_decision) {
        aiDecision = result.plan_decision;
        break;
      }
    }
  }

  // If we didn't find the decision in targets, search in response text
  if (!aiDecision && completedCommand.results?.[0]?.text) {
    try {
      const responseText = completedCommand.results[0].text;
      // Try to extract JSON from text
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        aiDecision = JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      console.error('Error parsing AI decision from text:', parseError);
    }
  }

  if (!aiDecision || !aiDecision.action) {
    throw new Error('AI did not provide a valid decision');
  }

  // Validate AI decision
  const validActions = ['continue_plan', 'modify_plan', 'new_plan'];
  if (!validActions.includes(aiDecision.action)) {
    throw new Error(`AI provided invalid action: ${aiDecision.action}`);
  }

  // Map action to shouldRegeneratePlan
  const shouldRegeneratePlan = aiDecision.action !== 'continue_plan';

  return {
    action: aiDecision.action,
    reason: aiDecision.reason || `AI decided: ${aiDecision.action}`,
    shouldRegeneratePlan
  };
}

/**
 * Core function to execute robot activity planning with unified context
 */
export async function executeUnifiedRobotActivityPlanning(
  siteId: string,
  agentId: string,
  userId: string,
  activity: string,
  previousSessions: any[],
  userContext?: string,
  previousPlanContext?: string
): Promise<{activityPlanResults: any[] | null, planningCommandUuid: string | null}> {
  try {
    // Get unified activity context with both user and previous plan context
    const activityContext = await getActivitySpecificContext(
      activity,
      siteId,
      userContext,
      previousPlanContext
    );

    // Execute planning using the unified context
    return await executeRobotActivityPlanning(
      siteId,
      agentId,
      userId,
      activity,
      previousSessions,
      activityContext
    );
  } catch (error) {
    console.error('❌ Error executing unified robot activity planning:', error);
    return { activityPlanResults: null, planningCommandUuid: null };
  }
}

/**
 * Core function to format and process plan steps consistently
 */
export function formatPlanSteps(planData: any): any[] {
  let planSteps: any[] = [];
  
  if (planData.phases && Array.isArray(planData.phases)) {
    // Extract steps from all phases and flatten
    planSteps = planData.phases.flatMap((phase: any, phaseIndex: number) => {
      if (!phase.steps || !Array.isArray(phase.steps)) return [];
      
      return phase.steps.map((step: any, stepIndex: number) => ({
        id: step.id || `phase_${phaseIndex + 1}_step_${stepIndex + 1}`,
        title: step.title || step.name || `Step ${stepIndex + 1}`,
        description: step.description || step.details || '',
        status: 'pending',
        order: (phaseIndex * 100) + stepIndex + 1, // To maintain order between phases
        type: step.type || 'task',
        instructions: step.instructions || step.description || step.details || '',
        expected_output: step.expected_output || step.outcome || '',
        expected_response_type: step.expected_response_type || 'step_completed',
        human_intervention_reason: step.human_intervention_reason || null,
        estimated_duration_minutes: (() => {
          const duration = step.estimated_duration || step.estimated_duration_minutes;
          if (typeof duration === 'number') return Math.min(duration, 4);
          if (typeof duration === 'string') {
            const match = duration.match(/(\d+)/);
            return match ? Math.min(parseInt(match[1]), 4) : 4;
          }
          return 4; // Default maximum 4 minutes
        })(),
        automation_level: step.automation_level || 'automated',
        required_authentication: step.required_authentication || 'none',
        // Tool specification fields for better execution guidance
        platform: step.platform || null,
        tool_section: step.tool_section || null,
        tool_name: step.tool_name || null,
        specific_ui_element: step.specific_ui_element || null,
        alternative_path: step.alternative_path || null,
        is_exploration_step: step.is_exploration_step || false,
        exploration_objective: step.exploration_objective || null,
        actual_output: null,
        started_at: null,
        completed_at: null,
        duration_seconds: null,
        retry_count: 0,
        error_message: null,
        artifacts: [],
        phase: phase.title || phase.name || `Phase ${phaseIndex + 1}`
      }));
    });
  } else if (planData.steps && Array.isArray(planData.steps)) {
    // If the plan already has steps directly
    planSteps = planData.steps.map((step: any, index: number) => ({
      id: step.id || `step_${index + 1}`,
      title: step.title || step.name || `Step ${index + 1}`,
      description: step.description || step.details || '',
      status: 'pending',
      order: index + 1,
      type: step.type || 'task',
      instructions: step.instructions || step.description || step.details || '',
      expected_output: step.expected_output || step.outcome || '',
      expected_response_type: step.expected_response_type || 'step_completed',
      human_intervention_reason: step.human_intervention_reason || null,
      estimated_duration_minutes: (() => {
        const duration = step.estimated_duration || step.estimated_duration_minutes;
        if (typeof duration === 'number') return Math.min(duration, 4);
        if (typeof duration === 'string') {
          const match = duration.match(/(\d+)/);
          return match ? Math.min(parseInt(match[1]), 4) : 4;
        }
        return 4; // Default maximum 4 minutes
      })(),
      automation_level: step.automation_level || 'automated',
      required_authentication: step.required_authentication || 'none',
      // Tool specification fields for better execution guidance
      platform: step.platform || null,
      tool_section: step.tool_section || null,
      tool_name: step.tool_name || null,
      specific_ui_element: step.specific_ui_element || null,
      alternative_path: step.alternative_path || null,
      is_exploration_step: step.is_exploration_step || false,
      exploration_objective: step.exploration_objective || null,
      actual_output: null,
      started_at: null,
      completed_at: null,
      duration_seconds: null,
      retry_count: 0,
      error_message: null,
      artifacts: []
    }));
  }

  return planSteps;
}

/**
 * Core function to add session save steps after authentication steps
 */
export function addSessionSaveSteps(planSteps: any[]): any[] {
  const stepsWithSessionSave: any[] = [];
  let currentOrder = 1;
  
  for (let i = 0; i < planSteps.length; i++) {
    const step = planSteps[i];
    step.order = currentOrder++;
    stepsWithSessionSave.push(step);
    
    // Check if this step is authentication (more precise)
    const isAuthStep = step.type === 'authentication' || 
                      step.expected_response_type === 'session_acquired' ||
                      (step.title?.toLowerCase().includes('login') && !step.title?.toLowerCase().includes('navigate')) ||
                      (step.title?.toLowerCase().includes('authenticate') && !step.title?.toLowerCase().includes('navigate')) ||
                      step.title?.toLowerCase().includes('sign in') ||
                      (step.description?.toLowerCase().includes('login') && step.description?.toLowerCase().includes('credentials')) ||
                      (step.description?.toLowerCase().includes('authenticate') && step.description?.toLowerCase().includes('credentials'));
    
    if (isAuthStep) {
      // Insert session save step immediately after
      const sessionSaveStep = {
        id: `session_save_after_step_${step.order}`,
        title: "Save authentication session",
        description: "Automatically save current authentication session to database and Scrapybara for future use",
        status: 'pending',
        order: currentOrder++,
        type: 'session_save',
        instructions: "Call /api/robots/auth endpoint to save current session after successful login",
        expected_output: "Session saved successfully with session ID and authentication status",
        expected_response_type: 'step_completed',
        human_intervention_reason: null,
        estimated_duration_minutes: 1,
        automation_level: 'automated',
        required_authentication: 'current_session',
        actual_output: null,
        started_at: null,
        completed_at: null,
        duration_seconds: null,
        retry_count: 0,
        error_message: null,
        artifacts: [],
        phase: step.phase || 'Authentication'
      };
      
      stepsWithSessionSave.push(sessionSaveStep);
      console.log(`🔐 ADDED: Session save step after authentication step: ${step.title}`);
    }
  }
  
  return stepsWithSessionSave;
}

/**
 * Core function to calculate estimated duration from timeline
 */
export function calculateEstimatedDuration(timelineValue: any): number {
  if (typeof timelineValue === 'number') {
    // Ensure it doesn't exceed 120 minutes (2 hours)
    return Math.min(timelineValue, 120);
  }
  if (typeof timelineValue === 'string') {
    // Search for numbers in string and convert
    const match = timelineValue.match(/(\d+)/);
    if (match) {
      const num = parseInt(match[1]);
      // Convert weeks to minutes if "week" found in string
      if (timelineValue.toLowerCase().includes('week')) {
        return Math.min(num * 7 * 24 * 60, 120); // maximum 2 hours
      }
      // Convert days to minutes if "day" found
      if (timelineValue.toLowerCase().includes('day')) {
        return Math.min(num * 24 * 60, 120); // maximum 2 hours
      }
      // If no unit specified, assume minutes
      return Math.min(num, 120); // maximum 2 hours
    }
  }
  return 120; // Default to 2 hours maximum for simple plans
}
