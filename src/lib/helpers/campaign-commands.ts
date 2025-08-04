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
  previousSessions: any[]
): Promise<{activityPlanResults: any[] | null, planningCommandUuid: string | null}> {
  try {
    console.log(`🤖 Ejecutando comando de planificación de actividad con Robot: ${agentId}`);
    
    // Build context for robot activity planning
    const robotPrompt = `Create a comprehensive activity plan for: ${activity}

ROLE: Growth Robot - Focus on systematic and automated execution of growth activities
OBJECTIVE: Develop a detailed plan for the specified activity with clear steps and automation opportunities

ACTIVITY PLANNING REQUIREMENTS:
- Create a structured plan with clear phases and steps
- Define specific actions and tasks for the activity
- Include automation opportunities and tools needed
- Set realistic timelines and milestones
- Consider previous authentication sessions for integrations
- Plan for measurement and optimization
- Include risk assessment and contingency plans

PLAN STRUCTURE ELEMENTS TO DEFINE:
1. Activity overview and objectives
2. Detailed step-by-step execution plan
3. Required tools and integrations
4. Timeline and scheduling requirements
5. Success metrics and KPIs
6. Automation opportunities
7. Dependencies and prerequisites
8. Risk mitigation strategies

OUTPUT FORMAT:
Provide a comprehensive activity plan with the following structure:
- Clear activity title and description
- Strategic objectives and expected outcomes
- Detailed execution phases with specific steps
- Required resources and tools
- Timeline with milestones
- Success metrics and tracking plan
- Automation recommendations
- Integration requirements

CONTEXT:
Activity: ${activity}
Previous Sessions: ${JSON.stringify(previousSessions, null, 2)}`;

    // Create command for robot activity planning
    const planningCommand = CommandFactory.createCommand({
      task: 'create growth activity plan',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: `Generate detailed activity plan for: ${activity}`,
      targets: [
        {
          deep_thinking: "Analyze the activity requirements and create strategic reasoning for the planning approach",
        },
        {
          activity_plan: {
            title: "Activity plan title",
            description: "Comprehensive description of the activity plan",
            activity_type: activity,
            objectives: ["List of specific objectives"],
            phases: [{
              phase_name: "Phase name",
              description: "Phase description",
              steps: [{
                step_number: 1,
                title: "Step title",
                description: "Step description",
                estimated_duration: "Duration estimate",
                tools_needed: ["List of required tools"],
                automation_level: "manual/semi-automated/automated"
              }],
              timeline: "Phase timeline",
              success_criteria: ["Success criteria for this phase"]
            }],
            success_metrics: ["KPIs and metrics to track"],
            required_integrations: ["List of needed integrations"],
            automation_opportunities: ["Areas for automation"],
            risks_and_mitigation: ["Risk factors and solutions"],
            estimated_timeline: "Overall timeline estimate",
            priority_level: "high/medium/low"
          }
        }
      ],
      context: robotPrompt
    });

    // Execute planning command
    const planningCommandId = await commandService.submitCommand(planningCommand);
    console.log(`🤖 Robot activity planning command created: ${planningCommandId}`);

    // Wait for planning completion
    const { command: planningResult, completed: planningCompleted, dbUuid } = await waitForCommandCompletion(planningCommandId);

    if (!planningCompleted || !planningResult) {
      console.error('❌ Robot activity planning command failed or timed out');
      return { activityPlanResults: null, planningCommandUuid: dbUuid };
    }

    // Extract planning results
    let planData = [];
    if (planningResult.results && Array.isArray(planningResult.results)) {
      for (const result of planningResult.results) {
        if (result.activity_plan) {
          planData.push(result.activity_plan);
          break;
        }
      }
    }

    console.log(`✅ Robot activity planning completed with ${planData.length} plan(s)`);
    return { activityPlanResults: planData, planningCommandUuid: dbUuid };

  } catch (error) {
    console.error('❌ Error executing Robot activity planning:', error);
    return { activityPlanResults: null, planningCommandUuid: null };
  }
} 