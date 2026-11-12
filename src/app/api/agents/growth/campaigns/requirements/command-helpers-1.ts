import { NextResponse } from 'next/server';
import { CommandFactory } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID, getCommandService, waitForCommandCompletion } from '@/lib/helpers/command-utils';
import { findTaskManagerAgent, findGrowthMarketerAgent, getPendingCampaigns } from '@/lib/helpers/agent-finder';

export async function executeTaskManagerRequirements(siteId: string, agentId: string, userId: string, campaignsData: any[]): Promise<{
    requirementsResults: any[] | null;
    requirementsCommandUuid: string | null;
}> {
    try {
        console.log(`📋 Ejecutando comando de generación de requisitos con Task Manager: ${agentId}`);
        const campaignsContext = `
CAMPAIGNS TO DEVELOP REQUIREMENTS FOR:
The following strategic campaigns have been planned and need detailed requirements. Create actionable requirements and tasks for each campaign:

${campaignsData.map((campaign, index) => `
CAMPAIGN ${index + 1}: ${campaign.title}
- ID: ${campaign.id}
- Description: ${campaign.description || 'N/A'}
- Type: ${campaign.type || 'N/A'}
- Priority: ${campaign.priority || 'N/A'}
- Budget: ${JSON.stringify(campaign.budget) || 'N/A'}
- Revenue Goals: ${JSON.stringify(campaign.revenue) || 'N/A'}
- Due Date: ${campaign.due_date || 'N/A'}
- Status: ${campaign.status || 'N/A'}
`).join('\n')}

IMPORTANT: Create specific, actionable requirements for each campaign above.
`;
        const taskManagerPrompt = `Create detailed, actionable requirements and tasks for the marketing campaigns that are currently pending.

ROLE: Task Manager - Focus on breaking down campaigns into executable tasks and requirements
OBJECTIVE: Transform strategic campaign plans into concrete, actionable requirements that teams can implement

REQUIREMENTS CREATION GUIDELINES:
- Break down each campaign into specific, measurable tasks
- All requirements MUST be created specifically to be executed autonomously by an AI agent
- Define clear deliverables and acceptance criteria for an AI
- Estimate effort and resource requirements
- Set realistic timelines and dependencies
- Include detailed instructions for execution, including CLEAR INSTRUCTIONS on whether the requirement will be done as an "external deliverable" or "using Makinari tools"
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

REQUIREMENT TYPES:
Assign one of these types to each requirement:
- content: Content creation, copywriting, blog posts, social media content
- design: Visual design, graphics, layouts, UI/UX work
- research: Market research, competitor analysis, audience research
- follow_up: Follow-up activities, nurturing sequences, customer outreach
- task: General tasks and administrative work
- develop: Development work, coding, technical implementation
- analytics: Data analysis, reporting, metrics tracking
- testing: A/B testing, quality assurance, performance testing
- approval: Review processes, stakeholder approvals, compliance
- coordination: Project coordination, team management, scheduling
- strategy: Strategic planning, campaign strategy, decision making
- optimization: Performance optimization, conversion optimization
- automation: Setting up automated processes, workflows
- integration: System integrations, third-party connections
- planning: Project planning, timeline creation, resource allocation
- payment: Budget deployment, ad spend allocation, payment processing, invoicing

OUTPUT FORMAT:
Provide detailed requirements with the following structure:
- Clear requirement title and description
- Detailed implementation instructions
- Priority level and urgency
- Type classification from the list above
- Estimated budget (numeric value only, no currency symbols)
- Dependencies and prerequisites
- Success criteria and definition of done
- Timeline and milestones

IMPORTANT:
- If the campaign is targeting a paid channel, assign a specific budget for the channel in a task, example:
  50 usd to design, copys, setup, etc., 100 usd to run the ads, total 150 usd for the campaign.

${campaignsContext}`;
        const requirementsCommand = CommandFactory.createCommand({
            task: 'create campaign requirements',
            userId: userId,
            agentId: agentId,
            agentRole: 'Growth Marketer',
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
                                instructions: "Detailed instructions to complete the requirement. MUST specify if it will be executed as an 'external deliverable' or 'using Makinari tools'.",
                                priority: "Requirement priority (low, medium, high)",
                                type: "Requirement type (content, design, research, follow_up, task, develop, analytics, testing, approval, coordination, payment)",
                                budget: "Budget for the requirement"
                            }]
                    }))
                }
            ],
            context: taskManagerPrompt
        });
        const requirementsCommandId = await getCommandService().submitCommand(requirementsCommand);
        console.log(`📋 Task Manager requirements command created: ${requirementsCommandId}`);
        const { command: requirementsResult, completed: requirementsCompleted, dbUuid } = await waitForCommandCompletion(requirementsCommandId);
        if (!requirementsCompleted || !requirementsResult) {
            console.error('❌ Task Manager requirements command failed or timed out');
            return { requirementsResults: null, requirementsCommandUuid: dbUuid };
        }
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
    }
    catch (error) {
        console.error('❌ Error executing Task Manager requirements generation:', error);
        return { requirementsResults: null, requirementsCommandUuid: null };
    }
}
export async function createRequirementsFromResults(campaignsWithRequirements: any[], siteId: string, userId: string, requirementsCommandUuid: string | null): Promise<{
    createdRequirements: any[];
    updatedCampaigns: any[];
}> {
    console.log(`🔄 Procesando resultados de Task Manager para crear requisitos...`);
    try {
        if (!campaignsWithRequirements || !Array.isArray(campaignsWithRequirements) || campaignsWithRequirements.length === 0) {
            console.log('Los resultados del Task Manager no tienen campañas con requisitos válidas');
            return { createdRequirements: [], updatedCampaigns: [] };
        }
        console.log(`🔑 Requirements Command UUID: ${requirementsCommandUuid}`);
        const validRequirementsId = requirementsCommandUuid && isValidUUID(requirementsCommandUuid);
        if (validRequirementsId) {
            const { data: commandExists, error: commandCheckError } = await supabaseAdmin
                .from('commands')
                .select('id')
                .eq('id', requirementsCommandUuid)
                .single();
            if (commandCheckError || !commandExists) {
                console.log(`⚠️ El requirements command_id ${requirementsCommandUuid} no existe en la tabla 'commands'`);
            }
        }
        console.log(`📝 Creando requisitos para ${campaignsWithRequirements.length} campañas`);
        const createdRequirements: any[] = [];
        const updatedCampaigns: any[] = [];
        for (const campaignWithReqs of campaignsWithRequirements) {
            const campaignId = campaignWithReqs.campaign_id;
            if (!campaignId || !isValidUUID(campaignId)) {
                console.log(`⚠️ Campaign ID inválido: ${campaignId}`);
                continue;
            }
            const { data: existingCampaign, error: campaignError } = await supabaseAdmin
                .from('campaigns')
                .select('*')
                .eq('id', campaignId)
                .single();
            if (campaignError || !existingCampaign) {
                console.log(`⚠️ Campaña no encontrada: ${campaignId}`);
                continue;
            }
            console.log(`📋 Procesando requisitos para campaña: ${existingCampaign.title}`);
            if (campaignWithReqs.requirements && Array.isArray(campaignWithReqs.requirements) && campaignWithReqs.requirements.length > 0) {
                console.log(`📝 Guardando ${campaignWithReqs.requirements.length} requisitos para la campaña ${campaignId}`);
                const requirementIds: string[] = [];
                for (const reqData of campaignWithReqs.requirements) {
                    const extractNumericBudget = (budgetValue: any): number => {
                        if (typeof budgetValue === 'number')
                            return budgetValue;
                        if (!budgetValue)
                            return 0;
                        const budgetStr = budgetValue.toString();
                        const match = budgetStr.match(/[\d.]+/);
                        return match ? parseFloat(match[0]) : 0;
                    };
                    const requirementToInsert = {
                        title: reqData.title || 'Requisito sin título',
                        description: reqData.description || '',
                        instructions: reqData.instructions || '',
                        budget: extractNumericBudget(reqData.budget),
                        priority: reqData.priority || 'medium',
                        type: reqData.type || 'task',
                        site_id: siteId,
                        status: 'backlog',
                        completion_status: 'pending',
                        user_id: userId,
                        ...(validRequirementsId ? { command_id: requirementsCommandUuid } : {})
                    };
                    const { data: insertedRequirement, error: reqInsertError } = await supabaseAdmin
                        .from('requirements')
                        .insert([requirementToInsert])
                        .select('*')
                        .single();
                    if (reqInsertError) {
                        console.error('Error al crear requisito:', reqInsertError);
                        continue;
                    }
                    console.log(`✅ Requisito creado con ID: ${insertedRequirement.id}`);
                    createdRequirements.push(insertedRequirement);
                    requirementIds.push(insertedRequirement.id);
                    await supabaseAdmin
                        .from('campaign_requirements')
                        .insert({
                        campaign_id: campaignId,
                        requirement_id: insertedRequirement.id
                    });
                }
                const { data: updatedCampaign, error: updateError } = await supabaseAdmin
                    .from('campaigns')
                    .update({ status: 'pending' })
                    .eq('id', campaignId)
                    .select('*')
                    .single();
                if (!updateError && updatedCampaign) {
                    console.log(`✅ Campaña ${campaignId} actualizada a estado 'pending'`);
                    updatedCampaigns.push({
                        ...updatedCampaign,
                        requirement_ids: requirementIds
                    });
                }
                else {
                    console.error('Error al actualizar estado de campaña:', updateError);
                    updatedCampaigns.push({
                        ...existingCampaign,
                        requirement_ids: requirementIds
                    });
                }
            }
            else {
                console.log(`⚠️ No se encontraron requisitos para la campaña ${campaignId}`);
                updatedCampaigns.push({
                    ...existingCampaign,
                    requirement_ids: []
                });
            }
        }
        return { createdRequirements, updatedCampaigns };
    }
    catch (error) {
        console.error('Error al crear requisitos a partir de resultados del Task Manager:', error);
        return { createdRequirements: [], updatedCampaigns: [] };
    }
}
