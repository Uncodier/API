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

⚠️ CRITICAL VALIDATION REQUIREMENTS:
- ALWAYS verify system data matches reality before executing actions
- If content/posts/ads appear "published" in system, validate they're actually visible online
- Check authentication sessions are still valid before using them
- If discrepancies found, include steps to recreate/republish missing elements
- Validate platform access and permissions before proceeding with any action
- Test all functionality works as expected rather than assuming from system status

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

SIMPLE EXECUTION STEPS (Maximum 5-8 steps):
Each step must be a specific, quick browser automation action:
- "VERIFY authentication and access to [Single Platform]"
- "CHECK if content/campaign already exists and is visible online"
- "If missing or outdated, recreate: Login to [Single Platform] using stored session"
- "Navigate to [Specific Tool/Section] for [One Campaign]"
- "Upload/Edit [One Content Piece] with [Simple Targeting]"
- "Configure basic settings for [One Campaign Element]"
- "Publish/Schedule [One Action] for [Specific Time]"
- "VALIDATE execution results are visible online and capture basic metrics"

OUTPUT FORMAT - KEEP SIMPLE:
Provide a FOCUSED execution plan with:
- Simple activity title (one sentence)
- Selected channel/platform (ONLY ONE)
- Customer journey stage focus (ONLY ONE)
- Quick execution steps (5-8 maximum)
- Simple timeline (1-2 hours total)
- Basic success metrics (1-3 key metrics)
- Single integration requirement

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
                description: "Specific browser automation step (click, type, navigate, etc.)",
                platform: "Platform/website where action occurs",
                estimated_duration: "Duration estimate for browser action",
                required_authentication: "Authentication session needed",
                automation_level: "automated"
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
      model: 'gpt-5',
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