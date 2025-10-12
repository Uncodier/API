import { CommandFactory } from '@/lib/agentbase';
import { commandService, waitForCommandCompletion } from './command-utils';

// Function to execute Growth Marketer campaign planning
export async function executeGrowthMarketerCampaignPlanning(
  siteId: string,
  agentId: string,
  userId: string,
  context: string
): Promise<{campaignPlanningResults: any[] | null, planningCommandUuid: string | null}> {
  try {
    console.log(`📊 Ejecutando comando de planificación de campañas con Growth Marketer: ${agentId}`);
    
    // Build context for growth marketer
    const growthMarketerPrompt = `Create strategic marketing campaigns focused on business growth and measurable impact.

ROLE: Growth Marketer - Focus on campaign strategy, audience targeting, and ROI optimization
OBJECTIVE: Develop comprehensive marketing campaigns that drive measurable business growth

CAMPAIGN PLANNING REQUIREMENTS:
- Create campaigns with clear business objectives and success metrics
- Define target audiences and customer segments for each campaign
- Establish realistic budgets and revenue projections
- Set appropriate timelines and milestones
- Consider different campaign types (inbound, outbound, branding, etc.)
- Plan campaigns that work synergistically together
- Include performance tracking and optimization strategies
- Balance short-term wins with long-term brand building

CAMPAIGN STRATEGY ELEMENTS TO DEFINE:
1. Campaign objectives and key results (OKRs)
2. Target audience segments and personas
3. Budget allocation and resource requirements
4. Timeline and key milestones
5. Marketing channels and tactics
6. Success metrics and KPIs
7. Risk assessment and mitigation strategies
8. Dependencies and prerequisites

OUTPUT FORMAT:
Provide strategic campaign plans with the following structure:
- Clear campaign title and description
- Strategic rationale and business goal
- Campaign type and approach
- Priority level based on business impact
- Budget requirements and revenue projections
- Timeline and due dates
- Target audience and messaging strategy
- Distribution channels and tactics
- Success metrics and tracking plan

${context}`;

    // Create command for growth marketer campaign planning
    const planningCommand = CommandFactory.createCommand({
      task: 'create strategic campaign planning',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: 'Generate strategic marketing campaign planning for business growth',
      targets: [
        {
          deep_thinking: "Analyze the business context and create strategic reasoning for the campaign planning approach",
        },
        {
          campaigns: [{
            title: "Campaign title",
            description: "Campaign description and strategic approach",
            type: "Campaign type (inbound, outbound, branding, product, events, success, account, community, guerrilla, affiliate, experiential, programmatic, performance, publicRelations)",
            priority: "Campaign priority (low, medium, high)",
            due_date: "ISO date string format YYYY-MM-DD, example: 2025-05-01",
            budget: {
              currency: "USD",
              allocated: 1000,
              remaining: 1000
            },
            revenue: {
              actual: 0,
              currency: "USD",
              estimated: 3000,
              projected: 5000
            },
            strategic_rationale: "Why this campaign is important for business growth",
            target_audience: "Primary target audience and customer segments",
            success_metrics: "KPIs and metrics to track campaign success",
            distribution_channels: "Marketing channels and tactics to be used"
          }]
        }
      ],
      context: growthMarketerPrompt
    });

    // Execute planning command
    const planningCommandId = await commandService.submitCommand(planningCommand);
    console.log(`📈 Growth Marketer campaign planning command created: ${planningCommandId}`);

    // Wait for planning completion
    const { command: planningResult, completed: planningCompleted, dbUuid } = await waitForCommandCompletion(planningCommandId);

    if (!planningCompleted || !planningResult) {
      console.error('❌ Growth Marketer campaign planning command failed or timed out');
      return { campaignPlanningResults: null, planningCommandUuid: dbUuid };
    }

    // Extract planning results
    let campaignsData = [];
    if (planningResult.results && Array.isArray(planningResult.results)) {
      for (const result of planningResult.results) {
        if (result.campaigns && Array.isArray(result.campaigns)) {
          campaignsData = result.campaigns;
          break;
        }
      }
    }

    console.log(`✅ Growth Marketer campaign planning completed with ${campaignsData.length} strategic campaigns`);
    return { campaignPlanningResults: campaignsData, planningCommandUuid: dbUuid };

  } catch (error) {
    console.error('❌ Error executing Growth Marketer campaign planning:', error);
    return { campaignPlanningResults: null, planningCommandUuid: null };
  }
}

// Function to execute Task Manager requirements generation
export async function executeTaskManagerRequirements(
  siteId: string,
  agentId: string,
  userId: string,
  campaignsData: any[]
): Promise<{requirementsResults: any[] | null, requirementsCommandUuid: string | null}> {
  try {
    console.log(`📋 Ejecutando comando de generación de requisitos con Task Manager: ${agentId}`);
    
    // Build context for task manager with campaigns data
    const campaignsContext = `
CAMPAIGNS TO DEVELOP REQUIREMENTS FOR:
The following strategic campaigns have been planned and need detailed requirements. Create actionable requirements and tasks for each campaign:

${campaignsData.map((campaign, index) => `
CAMPAIGN ${index + 1}: ${campaign.title}
- ID: ${campaign.id || 'N/A'}
- Description: ${campaign.description || 'N/A'}
- Type: ${campaign.type || 'N/A'}
- Priority: ${campaign.priority || 'N/A'}
- Strategic Rationale: ${campaign.strategic_rationale || 'N/A'}
- Target Audience: ${campaign.target_audience || 'N/A'}
- Budget: ${JSON.stringify(campaign.budget) || 'N/A'}
- Revenue Goals: ${JSON.stringify(campaign.revenue) || 'N/A'}
- Due Date: ${campaign.due_date || 'N/A'}
- Success Metrics: ${campaign.success_metrics || 'N/A'}
- Distribution Channels: ${campaign.distribution_channels || 'N/A'}
- Status: ${campaign.status || 'N/A'}
`).join('\n')}

IMPORTANT: Create specific, actionable requirements for each campaign above.
`;

    const taskManagerPrompt = `Create detailed, actionable requirements and tasks for the marketing campaigns that are currently pending.

ROLE: Task Manager - Focus on breaking down campaigns into executable tasks and requirements
OBJECTIVE: Transform strategic campaign plans into concrete, actionable requirements that teams can implement

REQUIREMENTS CREATION GUIDELINES:
- Break down each campaign into specific, measurable tasks
- Define clear deliverables and acceptance criteria
- Estimate effort and resource requirements
- Set realistic timelines and dependencies
- Include detailed instructions for execution
- Consider technical and creative requirements
- Plan for testing, optimization, and measurement
- Account for approval workflows and stakeholder review

REQUIREMENT STRUCTURE:
For each campaign, create multiple requirements that cover:
1. Content creation and creative development
2. Technical implementation and setup
3. Audience targeting and segmentation
4. Campaign launch and execution
5. Monitoring and optimization
6. Reporting and analysis
7. Follow-up and nurturing activities

OUTPUT FORMAT:
Provide detailed requirements with the following structure:
- Clear requirement title and description
- Detailed implementation instructions
- Priority level and urgency
- Estimated budget (numeric value only, no currency symbols)
- Dependencies and prerequisites
- Success criteria and definition of done
- Timeline and milestones

${campaignsContext}`;

    // Create command for task manager requirements generation
    const requirementsCommand = CommandFactory.createCommand({
      task: 'create campaign requirements',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: 'Generate detailed requirements and tasks for marketing campaigns',
      targets: [
        {
          deep_thinking: "Analyze the campaigns and create detailed reasoning for breaking them down into actionable requirements",
        },
        {
          campaigns_with_requirements: campaignsData.map(campaign => ({
            campaign_id: campaign.id,
            campaign_title: campaign.title,
            campaign_description: campaign.description,
            campaign_type: campaign.type,
            campaign_priority: campaign.priority,
            campaign_due_date: campaign.due_date,
            campaign_budget: campaign.budget,
            campaign_revenue: campaign.revenue,
            requirements: [{
              title: "Requirement title",
              description: "Requirement description",
              instructions: "Detailed instructions to complete the requirement",
              priority: "Requirement priority (low, medium, high)",
              budget: 100
            }]
          }))
        }
      ],
      context: taskManagerPrompt
    });

    // Execute requirements command
    const requirementsCommandId = await commandService.submitCommand(requirementsCommand);
    console.log(`📋 Task Manager requirements command created: ${requirementsCommandId}`);

    // Wait for requirements completion
    const { command: requirementsResult, completed: requirementsCompleted, dbUuid } = await waitForCommandCompletion(requirementsCommandId);

    if (!requirementsCompleted || !requirementsResult) {
      console.error('❌ Task Manager requirements command failed or timed out');
      return { requirementsResults: null, requirementsCommandUuid: dbUuid };
    }

    // Extract requirements results
    let campaignsWithRequirements = [];
    if (requirementsResult.results && Array.isArray(requirementsResult.results)) {
      for (const result of requirementsResult.results) {
        if (result.campaigns_with_requirements && Array.isArray(result.campaigns_with_requirements)) {
          campaignsWithRequirements = result.campaigns_with_requirements;
          break;
        }
      }
    }

    console.log(`✅ Task Manager requirements generation completed with ${campaignsWithRequirements.length} campaigns with requirements`);
    return { requirementsResults: campaignsWithRequirements, requirementsCommandUuid: dbUuid };

  } catch (error) {
    console.error('❌ Error executing Task Manager requirements generation:', error);
    return { requirementsResults: null, requirementsCommandUuid: null };
  }
}

// Function to execute Robot Activity Planning
export async function executeRobotActivityPlanning(
  siteId: string,
  agentId: string,
  userId: string,
  activity: string,
  previousSessions: any[],
  activityContext?: {
    additionalContext: string;
    specificInstructions: string;
    requiredData: string[];
  }
): Promise<{activityPlanResults: any[] | null, planningCommandUuid: string | null}> {
  try {
    // Prevent execution for free agent and ask activities
    const normalizedActivity = activity.toLowerCase().trim().replace(/[\s-_]+/g, '');
    const isFreeAgent = normalizedActivity === 'freeagent' || 
                       activity.toLowerCase().trim() === 'free agent' || 
                       activity.toLowerCase().trim() === 'free-agent';
    const isAsk = activity.toLowerCase().trim() === 'ask';
    
    if (isFreeAgent || isAsk) {
      console.log(`🚫 EVITANDO: Comando de planificación para actividad restringida (${isFreeAgent ? 'free agent' : 'ask'}) - retornando null`);
      return { activityPlanResults: null, planningCommandUuid: null };
    }
    
    console.log(`🤖 Ejecutando comando de planificación de actividad con Robot: ${agentId}`);
    
    // Get comprehensive company context
    const { getSegmentsSummaryForCampaigns, formatSegmentsContextForCampaigns } = await import('@/lib/helpers/segment-context');
    const { getLatestContent } = await import('@/lib/helpers/lead-context-helper');
    const { DataFetcher } = await import('@/lib/agentbase/services/agent/BackgroundServices/DataFetcher');
    
    // Get segments context
    const segmentsSummary = await getSegmentsSummaryForCampaigns(siteId);
    const segmentsContext = formatSegmentsContextForCampaigns(segmentsSummary);
    
    // Get active campaigns
    const activeCampaigns = await DataFetcher.getActiveCampaigns(siteId);
    
    // Get approved content (last 10 items)
    const approvedContent = await getLatestContent(siteId, 10);
    const approvedContentFiltered = approvedContent.filter(content => 
      content.status === 'approved' || content.status === 'published'
    );
    
    // Format campaigns context
    const campaignsContext = activeCampaigns.length > 0 
      ? `ACTIVE CAMPAIGNS (${activeCampaigns.length} total):\n` +
        activeCampaigns.map((campaign, index) => 
          `${index + 1}. **${campaign.title}**\n` +
          (campaign.description ? `   Description: ${campaign.description}\n` : '')
        ).join('\n') + '\n'
      : 'No active campaigns found for this site.\n\n';
    
    // Format approved content context
    const contentContext = approvedContentFiltered.length > 0
      ? `APPROVED CONTENT (Recent ${approvedContentFiltered.length} items):\n` +
        approvedContentFiltered.map((content, index) => 
          `${index + 1}. **${content.title}** (${content.type})\n` +
          (content.description ? `   Description: ${content.description}\n` : '') +
          `   Status: ${content.status}\n` +
          (content.segment_id ? `   Segment ID: ${content.segment_id}\n` : '') +
          (content.campaign_id ? `   Campaign ID: ${content.campaign_id}\n` : '')
        ).join('\n') + '\n'
      : 'No approved content found for this site.\n\n';
    
    // Combine all context including activity-specific context
    const companyContext = `${segmentsContext}\n${campaignsContext}${contentContext}${activityContext?.additionalContext || ''}`;
    
    // Build context for robot activity planning
    const robotPrompt = `Create a SIMPLE, FOCUSED activity plan for: ${activity}

ROLE: Growth Robot - Focus on automated browser execution of growth activities
OBJECTIVE: Generate a SIMPLE plan that can be executed in 1-2 HOURS maximum

${activityContext?.specificInstructions || ''}

🚨 CRITICAL SIMPLICITY REQUIREMENTS:
- Keep plans SIMPLE and FOCUSED - executable within 1-2 hours
- Select ONLY ONE channel/platform/strategy to focus on
- Use existing campaigns and content as foundation
- Maximum 5-8 automation steps total
- Focus on ONE customer journey stage at a time
- Prioritize quick wins over comprehensive coverage

⏱️ CRITICAL TIMING REQUIREMENTS:
- EACH STEP must be completable within 4 MINUTES maximum
- If a step requires more than 4 minutes, break it into smaller sub-steps
- Include realistic time estimates for each step (1-4 minutes each)
- Total plan execution should not exceed 120 minutes

⚠️ CRITICAL VALIDATION REQUIREMENTS:
- ALWAYS verify system data matches reality before executing actions
- If content/posts/ads appear "published" in system, validate they're actually visible online
- Check authentication sessions are still valid before using them
- If discrepancies found, include steps to recreate/republish missing elements
- Validate platform access and permissions before proceeding with any action
- Test all functionality works as expected rather than assuming from system status

🎯 MANDATORY FOCUS AND VALIDATION STEPS:
For EVERY plan, you MUST include these types of steps to simplify agent tasks:

1. CONTENT FOCUS STEPS (at the beginning):
   - "Focus on [specific content/campaign/platform] - ignore all other distractions"
   - "Verify the target [content/campaign/platform] is loaded and visible"
   - "Confirm we are working with the correct [item] before proceeding"

2. VALIDATION CHECKPOINTS (throughout the plan):
   - "Validate that [expected content] loaded successfully"
   - "Confirm [action] was completed as expected"
   - "Verify [result] is visible and correct before continuing"
   - "Check that [data/content] was saved/published correctly"

3. CONTENT VERIFICATION STEPS (after major actions):
   - "Refresh page to confirm changes are persistent"
   - "Navigate away and back to verify content is saved"
   - "Check that published content appears in the expected location"
   - "Validate all links/images/media are working correctly"

EXAMPLES OF FOCUS AND VALIDATION INTEGRATION:
✅ Good Step Sequence:
1. "Focus on LinkedIn company page - navigate to linkedin.com/company/[name]"
2. "Verify company page loaded correctly and shows current branding"
3. "Click on 'Create a post' button"
4. "Validate post creation dialog opened successfully"
5. "Paste approved content into post text area"
6. "Confirm content appears correctly formatted in preview"
7. "Click 'Post' to publish"
8. "Validate post appears in company feed and is publicly visible"
9. "Refresh page to confirm post is persistent and properly saved"

🎭 STEP RESPONSE COORDINATION:
For EACH step in your plan, you MUST specify the expected_response_type that the robot will use during execution:

AVAILABLE RESPONSE TYPES:
- "step_completed" - Normal step that should complete successfully
- "step_failed" - Step that might fail due to technical issues
- "session_needed" - Step that requires authentication/login
- "user_attention_required" - Step that needs human intervention (CAPTCHAs, manual verification, etc.)
- "session_acquired" - Step that successfully establishes authentication
- "step_canceled" - Step that might be skipped if conditions aren't met

🔐 CRITICAL SESSION SAVE REQUIREMENT:
MANDATORY: After ANY authentication/login step (type: "authentication" or expected_response_type: "session_acquired"), you MUST automatically include a session save step immediately after.

SESSION SAVE STEP FORMAT:
{
  "title": "Save authentication session",
  "description": "Automatically save the current authentication session to database and Scrapybara for future use",
  "step_number": [next_number],
  "automation_level": "automated",
  "estimated_duration": "1 minute",
  "expected_response_type": "step_completed",
  "type": "session_save",
  "required_authentication": "current_session",
  "human_intervention_reason": null
}

MANDATORY: Predict which steps will likely need human intervention and mark them as "user_attention_required" in advance.

EXAMPLES OF STEPS REQUIRING HUMAN INTERVENTION:
- Login steps with 2FA/CAPTCHA
- Manual verification of published content
- Approval of campaign settings before publishing
- Resolution of platform-specific errors
- Manual data entry for sensitive information

📋 PLAN SIMPLIFICATION GUIDELINES:
- Choose the SINGLE most effective channel based on customer journey context
- Focus on ONE specific campaign or content piece from existing context
- Target ONE primary segment/audience
- Limit scope to achievable actions within 2-hour timeframe
- Avoid multi-platform or complex integration plans
- Select tactics that align with current customer journey stage

🎯 SINGLE CHANNEL SELECTION:
Based on the provided context, choose ONLY ONE channel/platform:
- LinkedIn (for B2B awareness/consideration stages)
- Facebook/Instagram (for broader awareness/retention)
- Email (for consideration/decision stages)
- Google Ads (for decision/purchase stages)
- Website optimization (for conversion optimization)
- Content creation (for awareness/retention)

🔧 CRITICAL STEP DECOMPOSITION REQUIREMENTS:
ALWAYS break down complex tasks into simple, executable steps:

✅ GOOD STEP EXAMPLES:
- "Navigate to linkedin.com"
- "Click on the search bar at the top of the page"
- "Type 'Santiago Zavala' in the search field"
- "Press Enter to execute the search"
- "Click on the first profile result"
- "Scroll down to view recent posts"
- "Click on the first post to open it"
- "Click the comment button below the post"
- "Type a positive comment about the post content"
- "Click 'Post' to submit the comment"

❌ AVOID VAGUE STEPS:
- "Research Santiago Zavala" (too vague)
- "Find and comment on posts" (too complex)
- "Engage with content" (not specific)
- "Analyze profile" (not actionable)

🎯 STEP DECOMPOSITION RULES:
- Each step = ONE specific browser action (click, type, navigate, scroll)
- Use action verbs: Navigate, Click, Type, Select, Scroll, Press
- Include specific targets: "search bar", "first result", "comment button"
- Maximum 1-4 minutes per step
- If a task takes longer, break it into smaller sub-steps

🔍 TOOL DISCOVERY & PLATFORM EXPLORATION REQUIREMENTS:
When working with apps/websites, ALWAYS include exploration steps to discover available tools/features:

EXPLORATION STEP EXAMPLES:
- "Navigate to [platform] dashboard to identify available sections and tools"
- "Locate and inspect the main navigation menu to discover available features"
- "Click on 'Settings' or 'Tools' section to explore configuration options"
- "Search for [feature name] in the platform's search bar to find the tool"
- "Browse through available menu options to identify the correct section for [task]"
- "Check platform documentation or help center to understand tool usage"
- "Inspect the UI to identify buttons, menus, or sections related to [objective]"
- "Navigate to [platform]/help or [platform]/docs to research available features"

🛠️ SPECIFIC TOOL USAGE INSTRUCTIONS:
For EVERY platform interaction, specify the exact tools/sections to use:

PLATFORM-SPECIFIC EXAMPLES:

LinkedIn:
- "Navigate to LinkedIn Campaign Manager at linkedin.com/campaignmanager"
- "Click on 'Create Campaign' button in the top right corner"
- "Use LinkedIn's 'Audience Network' tool to expand reach"
- "Access 'Analytics' section to review campaign performance"

Facebook/Instagram:
- "Navigate to Facebook Ads Manager at business.facebook.com/adsmanager"
- "Use 'Audiences' tool under Assets menu to create custom audiences"
- "Access 'Creative Hub' to preview ad creatives before publishing"
- "Use Instagram's 'Professional Dashboard' to schedule posts"

Google Ads:
- "Navigate to Google Ads campaign creation at ads.google.com/campaigns/new"
- "Use 'Keyword Planner' tool to research and select keywords"
- "Access 'Recommendations' tab to optimize campaign settings"
- "Use 'Display Planner' to find placements for display ads"

Email Platforms:
- "Navigate to campaign creation section in [email platform]"
- "Use 'Segmentation' or 'Audience' tool to select target recipients"
- "Access 'Template Library' or 'Design' section to create email content"
- "Use 'A/B Testing' or 'Split Test' tool to test email variations"

🔬 RESEARCH & INVESTIGATION STEPS:
When platform/tool is unknown or unclear, include MANDATORY investigation steps:

INVESTIGATION PROTOCOL:
1. "Navigate to [platform] homepage to familiarize with layout and features"
2. "Locate and click on 'Help', 'Documentation', or '?' icon to access platform guides"
3. "Search for '[specific task]' in platform's help center or documentation"
4. "Explore main navigation menus to map available sections and tools"
5. "Look for 'Getting Started', 'Tutorials', or 'Guides' section to learn platform workflow"
6. "If uncertain about feature location, use platform's internal search tool"
7. "Check for tooltips or info icons (i) next to features for usage instructions"
8. "Review platform's API documentation if automation/integration is needed"

⚠️ MANDATORY TOOL SPECIFICATION:
For EVERY action step, you MUST specify:
- The exact section/menu where the tool is located (e.g., "Under 'Campaigns' > 'Create New'")
- The button/link text to click (e.g., "Click the blue 'Create Campaign' button")
- The tool/feature name to use (e.g., "Use the 'Audience Targeting' tool")
- Alternative paths if primary method is unavailable (e.g., "If 'Create Campaign' is not visible, click '+ New' icon")

STEP FORMAT WITH TOOL SPECIFICATION:
{
  "title": "Create campaign using Campaign Manager",
  "description": "Navigate to Campaign Manager tool (under 'Marketing' menu) and click 'Create Campaign' button to initiate campaign setup wizard",
  "platform": "LinkedIn",
  "tool_section": "Marketing > Campaign Manager",
  "tool_name": "Campaign Creation Wizard",
  "specific_ui_element": "Blue 'Create Campaign' button in top right",
  "alternative_path": "Can also access via dashboard '+ Create' dropdown > 'Campaign'",
  "step_number": 1,
  "automation_level": "automated",
  "estimated_duration": "2 minutes"
}

SIMPLE EXECUTION STEPS (Maximum 5-8 steps):
Each step must be a specific, quick browser automation action with coordinated response:

COMPLETE STEP FORMAT EXAMPLES:

Example 1 - Exploration Step:
{
  "title": "Explore LinkedIn Campaign Manager interface",
  "description": "Navigate to linkedin.com/campaignmanager to discover available campaign types and tools. Inspect the main navigation menu to identify sections like 'Create Campaign', 'Analytics', and 'Audiences'.",
  "platform": "LinkedIn",
  "tool_section": "Campaign Manager Dashboard",
  "tool_name": "Campaign Manager",
  "specific_ui_element": "Main navigation sidebar with campaign options",
  "alternative_path": "Can access via LinkedIn main menu > Advertise > Campaign Manager",
  "is_exploration_step": true,
  "exploration_objective": "Identify available campaign creation tools and campaign types supported by LinkedIn",
  "step_number": 1,
  "automation_level": "automated",
  "estimated_duration": "2 minutes",
  "expected_response_type": "step_completed",
  "required_authentication": "linkedin"
}

Example 2 - Tool Usage Step:
{
  "title": "Create new LinkedIn campaign using Campaign Wizard",
  "description": "Click the 'Create Campaign' button in the top right corner of Campaign Manager. This will open the Campaign Creation Wizard where you can select campaign objective.",
  "platform": "LinkedIn",
  "tool_section": "Campaign Manager > Create",
  "tool_name": "Campaign Creation Wizard",
  "specific_ui_element": "Blue 'Create Campaign' button in top right corner",
  "alternative_path": "Can also click '+ New' dropdown and select 'Campaign'",
  "is_exploration_step": false,
  "step_number": 2,
  "automation_level": "automated",
  "estimated_duration": "2 minutes",
  "expected_response_type": "step_completed",
  "required_authentication": "linkedin"
}

Example 3 - Research/Unknown Platform Step:
{
  "title": "Research HubSpot campaign creation process",
  "description": "Navigate to HubSpot help center (help.hubspot.com) and search for 'create marketing campaign'. Read the documentation to understand the required steps and tools available.",
  "platform": "HubSpot Documentation",
  "tool_section": "Help Center > Marketing Hub",
  "tool_name": "Documentation Search",
  "specific_ui_element": "Search bar in help center header",
  "alternative_path": "Can also navigate to HubSpot Academy for video tutorials",
  "is_exploration_step": true,
  "exploration_objective": "Learn the proper workflow and tools for creating campaigns in HubSpot Marketing Hub",
  "step_number": 1,
  "automation_level": "automated",
  "estimated_duration": "3 minutes",
  "expected_response_type": "step_completed",
  "required_authentication": null
}

Example 4 - Authentication Step:
{
  "title": "Login to Facebook Ads Manager",
  "description": "Navigate to business.facebook.com/adsmanager and authenticate using stored session credentials",
  "platform": "Facebook",
  "tool_section": "Ads Manager Login",
  "tool_name": "Facebook Authentication",
  "specific_ui_element": "Login form or session restoration",
  "alternative_path": "Can access via facebook.com and click on 'Ad Manager' in main menu",
  "is_exploration_step": false,
  "step_number": 1,
  "automation_level": "automated",
  "estimated_duration": "3 minutes",
  "expected_response_type": "session_needed",
  "human_intervention_reason": "May require 2FA or CAPTCHA verification",
  "required_authentication": "facebook"
}

COORDINATION EXAMPLES:
- Authentication steps → expected_response_type: "session_needed" or "session_acquired"
- Content validation → expected_response_type: "user_attention_required" 
- Technical operations → expected_response_type: "step_completed" or "step_failed"
- Platform navigation → expected_response_type: "step_completed"
- Publishing actions → expected_response_type: "user_attention_required" (for approval)

🎓 WHEN TO INCLUDE EXPLORATION STEPS:
You MUST include exploration/research steps when:
1. Working with a platform/tool you're not familiar with
2. The specific tool location or workflow is unclear
3. Multiple ways to achieve the objective exist (explore to find the best)
4. Platform UI may have changed since training data
5. Need to verify available features before proceeding
6. Documentation review would prevent errors or improve efficiency

COMPLETE PLAN EXAMPLE WITH EXPLORATION:

Activity: "Create and publish LinkedIn sponsored content campaign"

Step 1 (Exploration):
{
  "title": "Explore LinkedIn Campaign Manager to identify campaign types",
  "description": "Navigate to linkedin.com/campaignmanager and inspect available campaign types. Locate 'Sponsored Content' option and identify the campaign creation workflow.",
  "platform": "LinkedIn",
  "tool_section": "Campaign Manager > Dashboard",
  "tool_name": "Campaign Type Selector",
  "specific_ui_element": "Campaign type cards or dropdown menu",
  "alternative_path": "Click 'Create Campaign' and explore objectives menu",
  "is_exploration_step": true,
  "exploration_objective": "Confirm Sponsored Content is available and understand creation workflow",
  "step_number": 1,
  "estimated_duration": "2 minutes",
  "expected_response_type": "step_completed",
  "required_authentication": "linkedin"
}

Step 2 (Action):
{
  "title": "Initiate Sponsored Content campaign creation",
  "description": "Click 'Create Campaign' button and select 'Brand Awareness' objective, then choose 'Sponsored Content' as the format.",
  "platform": "LinkedIn",
  "tool_section": "Campaign Manager > Create > Objective Selection",
  "tool_name": "Campaign Creation Wizard",
  "specific_ui_element": "'Create Campaign' blue button, then 'Brand Awareness' card",
  "alternative_path": "Can use '+ New Campaign' dropdown if visible",
  "is_exploration_step": false,
  "step_number": 2,
  "estimated_duration": "2 minutes",
  "expected_response_type": "step_completed",
  "required_authentication": "linkedin"
}

Step 3 (Tool Usage):
{
  "title": "Configure audience targeting using Audience Manager",
  "description": "Use LinkedIn's Audience Targeting tool to define target audience. Access under 'Audience' section and select criteria like location, job title, and industry.",
  "platform": "LinkedIn",
  "tool_section": "Campaign Manager > Campaign Settings > Audience",
  "tool_name": "Audience Targeting Tool",
  "specific_ui_element": "Audience criteria dropdowns and search fields",
  "alternative_path": "Can import saved audience from Matched Audiences library",
  "is_exploration_step": false,
  "step_number": 3,
  "estimated_duration": "3 minutes",
  "expected_response_type": "step_completed",
  "required_authentication": "linkedin"
}

OUTPUT FORMAT - KEEP SIMPLE:
Provide a FOCUSED execution plan with:
- Simple activity title (one sentence)
- Selected channel/platform (ONLY ONE)
- Customer journey stage focus (ONLY ONE)
- Quick execution steps (5-8 maximum) with ALL required fields:
  * title, description, platform
  * tool_section, tool_name, specific_ui_element, alternative_path
  * is_exploration_step, exploration_objective (if applicable)
  * step_number, automation_level, estimated_duration
  * expected_response_type, required_authentication
- Simple timeline (1-2 hours total, 1-4 minutes per step)
- Basic success metrics (1-3 key metrics)
- Single integration requirement
- Human intervention points clearly identified
- AT LEAST one exploration step if platform workflow is unclear

COMPLETE COMPANY CONTEXT (Choose the BEST single option from this):

${companyContext}

ACTIVITY CONTEXT:
Activity: ${activity}
Previous Authentication Sessions: ${JSON.stringify(previousSessions, null, 2)}

⚠️ SIMPLICITY REMINDERS:
- ONE channel, ONE strategy, ONE focus area
- Maximum 2 hours execution time
- Use existing content and campaigns (don't create new ones)
- Focus on immediate, measurable actions
- Avoid complex multi-step workflows
- Select the highest-impact, lowest-effort approach
- Align with ONE customer journey stage based on current context

⚠️ VALIDATION REMINDERS:
- NEVER assume system status reflects reality
- ALWAYS include verification steps in execution plan
- If something appears published/completed, check it's actually visible/working
- Include troubleshooting steps for when system data doesn't match reality
- Validate before executing, execute with verification, verify after completion`;

    // Create command for robot activity execution
    const planningCommand = CommandFactory.createCommand({
      task: 'create browser execution plan',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: `Generate browser automation steps for: ${activity}`,
      targets: [
        {
          deep_thinking: "Analyze the activity requirements and create browser automation steps using existing campaigns and content",
        },
        {
          activity_plan: {
            title: "Browser execution plan title",
            description: "Comprehensive description of browser automation execution",
            activity_type: activity,
            execution_objectives: ["List of specific execution objectives using existing campaigns/content"],
            phases: [{
              phase_name: "Execution phase name",
              description: "Browser automation phase description",
              steps: [{
                step_number: 1,
                title: "Browser action title",
                description: "Detailed browser automation step with specific tool/section information (e.g., 'Navigate to Campaign Manager under Marketing menu and click Create Campaign button')",
                platform: "Platform/website where action occurs (e.g., 'LinkedIn', 'Facebook Ads Manager')",
                tool_section: "Exact menu path to the tool (e.g., 'Marketing > Campaign Manager', 'Assets > Audiences')",
                tool_name: "Specific tool or feature name being used (e.g., 'Campaign Creation Wizard', 'Audience Targeting Tool')",
                specific_ui_element: "Exact UI element to interact with (e.g., 'Blue Create Campaign button in top right', 'Search bar in header')",
                alternative_path: "Alternative way to access the tool if primary method fails (e.g., 'Can also access via + Create dropdown')",
                is_exploration_step: false,
                exploration_objective: "If exploration step, what are we trying to discover (e.g., 'Identify available campaign types', 'Locate analytics section')",
                estimated_duration: "Duration estimate for browser action (1-4 minutes)",
                required_authentication: "Authentication session needed (e.g., 'linkedin', 'facebook')",
                automation_level: "automated",
                expected_response_type: "step_completed"
              }],
              timeline: "Execution timeline",
              success_criteria: ["Measurable success criteria for automation"]
            }],
            success_metrics: ["Automated tracking metrics"],
            required_integrations: ["Platform integrations and authentication sessions"],
            browser_requirements: ["Browser automation requirements"],
            error_handling: ["Error scenarios and retry strategies"],
            estimated_timeline: "Overall execution timeline",
            priority_level: "high/medium/low"
          }
        }
      ],
      context: robotPrompt,
      // Set model for growth robot planning
      model: 'gpt-4o',
      modelType: 'openai'
    });

    // Execute browser automation command
    const planningCommandId = await commandService.submitCommand(planningCommand);
    console.log(`🤖 Robot browser execution command created: ${planningCommandId}`);

    // Wait for execution planning completion
    const { command: planningResult, completed: planningCompleted, dbUuid } = await waitForCommandCompletion(planningCommandId);

    if (!planningCompleted || !planningResult) {
      console.error('❌ Robot browser execution command failed or timed out');
      return { activityPlanResults: null, planningCommandUuid: dbUuid };
    }

    // Extract execution results
    let planData = [];
    if (planningResult.results && Array.isArray(planningResult.results)) {
      for (const result of planningResult.results) {
        if (result.activity_plan) {
          planData.push(result.activity_plan);
          break;
        }
      }
    }

    console.log(`✅ Robot browser execution plan completed with ${planData.length} plan(s)`);
    return { activityPlanResults: planData, planningCommandUuid: dbUuid };

  } catch (error) {
    console.error('❌ Error executing Robot browser automation planning:', error);
    return { activityPlanResults: null, planningCommandUuid: null };
  }
} 