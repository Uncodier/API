import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { getLeadInfo, getLeadTasks, getLeadConversations, getPreviousInteractions } from '@/lib/helpers/lead-context-helper';
import { isValidUUID, getConvertedLeadsBySegment, getLostLeadsBySegment, getTeamMemberAttributionsBySegment, commandService, findActiveSalesAgent } from './command-helpers-1';
import { getSiteChannelsConfiguration, getAvailableTeamMembers, waitForCommandCompletion, processLeadData, groupLeadsByCompany } from './command-helpers-2';
async function handleCommandRequest(request: Request) {
    try {
        const body = await request.json();
        const { siteId, leads, userId, agent_id, includeTeamMembers = true, priorityFactors = {
            recentActivity: 0.3,
            companySize: 0.2,
            engagement: 0.3,
            leadScore: 0.2
        } } = body;
        if (!siteId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } }, { status: 400 });
        }
        if (!leads || !Array.isArray(leads) || leads.length === 0) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'leads array is required and must not be empty' } }, { status: 400 });
        }
        console.log(`🎯 Iniciando selección de leads para ${leads.length} leads en sitio: ${siteId}`);
        let effectiveAgentId = agent_id;
        let agentInfo: any = null;
        let effectiveUserId = userId;
        if (!effectiveAgentId) {
            const foundAgent = await findActiveSalesAgent(siteId);
            if (foundAgent) {
                effectiveAgentId = foundAgent.agentId;
                effectiveUserId = foundAgent.userId;
                console.log(`🤖 Usando agente de ventas encontrado: ${effectiveAgentId} (user_id: ${effectiveUserId})`);
            }
            else {
                console.log(`⚠️ No se encontró un agente activo para el sitio: ${siteId}`);
            }
        }
        if (!effectiveUserId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required and no active agent found for the site' } }, { status: 400 });
        }
        console.log(`📋 Procesando información de ${leads.length} leads...`);
        const leadsData = [];
        for (const leadInput of leads) {
            let leadId: string;
            if (typeof leadInput === 'string') {
                leadId = leadInput;
            }
            else if (leadInput && leadInput.id) {
                leadId = leadInput.id;
            }
            else {
                console.warn(`⚠️ Lead input inválido:`, leadInput);
                continue;
            }
            if (!isValidUUID(leadId)) {
                console.warn(`⚠️ Lead ID inválido: ${leadId}`);
                continue;
            }
            const leadData = await processLeadData(leadId);
            if (leadData) {
                leadsData.push(leadData);
            }
        }
        console.log(`✅ Procesados exitosamente ${leadsData.length} de ${leads.length} leads`);
        if (leadsData.length === 0) {
            return NextResponse.json({ success: false, error: { code: 'NO_VALID_LEADS', message: 'No valid leads found to process' } }, { status: 400 });
        }
        const companiesMap = groupLeadsByCompany(leadsData);
        console.log(`🏢 Leads agrupados en ${companiesMap.size} compañías`);
        let teamMembers: any[] = [];
        if (includeTeamMembers) {
            teamMembers = await getAvailableTeamMembers(siteId);
        }
        const siteChannelsConfig = await getSiteChannelsConfiguration(siteId);
        const convertedLeadsBySegment = await getConvertedLeadsBySegment(siteId);
        const lostLeadsBySegment = await getLostLeadsBySegment(siteId);
        const teamMemberAttributionsBySegment = await getTeamMemberAttributionsBySegment(siteId);
        let contextMessage = `Lead Selection Analysis for Site: ${siteId}\n\n`;
        contextMessage += `Total Leads to Analyze: ${leadsData.length}\n`;
        contextMessage += `Companies Represented: ${companiesMap.size}\n\n`;
        contextMessage += `=== DETAILED COMPANY ANALYSIS ===\n\n`;
        let companyIndex = 1;
        for (const [companyName, companyLeads] of Array.from(companiesMap.entries())) {
            contextMessage += `COMPANY ${companyIndex}: ${String(companyName).toUpperCase()}\n`;
            contextMessage += `├─ Total Leads: ${companyLeads.length}\n\n`;
            companyLeads.forEach((leadData: any, index: number) => {
                const lead = leadData.lead;
                const tasks = leadData.tasks;
                const conversations = leadData.conversations;
                const interactions = leadData.interactions;
                contextMessage += `   LEAD ${index + 1} - ${lead.name || 'Unknown'}\n`;
                contextMessage += `   ├─ ID: ${lead.id}\n`;
                contextMessage += `   ├─ Email: ${lead.email || 'N/A'}\n`;
                contextMessage += `   ├─ Phone: ${lead.phone || 'N/A'}\n`;
                contextMessage += `   ├─ Position: ${lead.position || 'N/A'}\n`;
                contextMessage += `   ├─ Status: ${lead.status || 'N/A'}\n`;
                contextMessage += `   ├─ Created: ${lead.created_at}\n`;
                contextMessage += `   ├─ Assignee: ${lead.assignee_id ? lead.assignee_id : 'Unassigned'}\n`;
                if (lead.lead_score) {
                    contextMessage += `   ├─ Lead Score: ${lead.lead_score}\n`;
                }
                if (lead.pain_points && Array.isArray(lead.pain_points)) {
                    contextMessage += `   ├─ Pain Points: ${lead.pain_points.join(', ')}\n`;
                }
                if (lead.budget_range) {
                    contextMessage += `   ├─ Budget Range: ${lead.budget_range}\n`;
                }
                contextMessage += `   ├─ Tasks: ${tasks.length} total\n`;
                if (tasks.length > 0) {
                    tasks.slice(0, 3).forEach((task: any, taskIndex: number) => {
                        contextMessage += `   │   ${taskIndex + 1}. ${task.title} (${task.status})\n`;
                    });
                    if (tasks.length > 3) {
                        contextMessage += `   │   ... and ${tasks.length - 3} more tasks\n`;
                    }
                }
                contextMessage += `   ├─ Conversations: ${conversations.length} total\n`;
                if (conversations.length > 0) {
                    conversations.slice(0, 2).forEach((conv: any, convIndex: number) => {
                        contextMessage += `   │   ${convIndex + 1}. ${conv.title || 'Untitled'} (${conv.status}) - ${conv.created_at}\n`;
                    });
                    if (conversations.length > 2) {
                        contextMessage += `   │   ... and ${conversations.length - 2} more conversations\n`;
                    }
                }
                contextMessage += `   └─ Recent Interactions: ${interactions.length} total\n`;
                if (interactions.length > 0) {
                    interactions.slice(0, 2).forEach((interaction: any, intIndex: number) => {
                        contextMessage += `       ${intIndex + 1}. ${interaction.type}: ${interaction.title || 'N/A'} - ${interaction.created_at}\n`;
                    });
                    if (interactions.length > 2) {
                        contextMessage += `       ... and ${interactions.length - 2} more interactions\n`;
                    }
                }
                contextMessage += `\n`;
            });
            companyIndex++;
            contextMessage += `\n`;
        }
        contextMessage += `=== CONVERTED LEADS BY SEGMENT ===\n\n`;
        for (const [segmentName, leads] of Object.entries(convertedLeadsBySegment)) {
            contextMessage += `Segment: ${String(segmentName).toUpperCase()}\n`;
            contextMessage += `├─ Total Converted: ${leads.length}\n`;
            if (leads.length > 0) {
                leads.slice(0, 3).forEach((lead: any, index: number) => {
                    contextMessage += `   ${index + 1}. ${lead.name || 'Unknown'} (ID: ${lead.id}, Sales: ${lead.sales?.length || 0})\n`;
                });
                if (leads.length > 3) {
                    contextMessage += `   ... and ${leads.length - 3} more converted leads\n`;
                }
            }
            contextMessage += `\n`;
        }
        contextMessage += `=== LOST LEADS BY SEGMENT ===\n\n`;
        for (const [segmentName, leads] of Object.entries(lostLeadsBySegment)) {
            contextMessage += `Segment: ${String(segmentName).toUpperCase()}\n`;
            contextMessage += `├─ Total Lost: ${leads.length}\n`;
            if (leads.length > 0) {
                leads.slice(0, 3).forEach((lead: any, index: number) => {
                    contextMessage += `   ${index + 1}. ${lead.name || 'Unknown'} (ID: ${lead.id}, Attribution: ${lead.attribution?.name || 'N/A'})\n`;
                });
                if (leads.length > 3) {
                    contextMessage += `   ... and ${leads.length - 3} more lost leads\n`;
                }
            }
            contextMessage += `\n`;
        }
        contextMessage += `=== TEAM MEMBER ATTRIBUTIONS BY SEGMENT ===\n\n`;
        for (const [segmentName, assigneeData] of Object.entries(teamMemberAttributionsBySegment)) {
            contextMessage += `Segment: ${String(segmentName).toUpperCase()}\n`;
            contextMessage += `├─ Best Assignee: ${assigneeData.name || 'N/A'} (ID: ${assigneeData.assignee_id}, Score: ${assigneeData.score})\n`;
            contextMessage += `│  ├─ Conversions: ${assigneeData.conversions}\n`;
            contextMessage += `│  └─ Total Sales: ${assigneeData.total_sales.toLocaleString()}\n`;
            if (assigneeData.attribution_data && assigneeData.attribution_data.length > 0) {
                contextMessage += `│  └─ Attribution Data: ${assigneeData.attribution_data.length} records\n`;
            }
            contextMessage += `\n`;
        }
        if (teamMembers.length > 0) {
            contextMessage += `=== AVAILABLE TEAM MEMBERS ===\n\n`;
            teamMembers.forEach((member, index) => {
                contextMessage += `${index + 1}. ${member.name} (${member.role})\n`;
                contextMessage += `   ├─ ID: ${member.id}\n`;
                contextMessage += `   └─ Email: ${member.email}\n\n`;
            });
        }
        contextMessage += `=== SITE CHANNELS CONFIGURATION ===\n\n`;
        if (siteChannelsConfig.hasChannels) {
            contextMessage += `Site has ${siteChannelsConfig.configuredChannels.length} channels configured:\n\n`;
            siteChannelsConfig.configuredChannels.forEach((channelType, index) => {
                const channelDetails = siteChannelsConfig.channelsDetails[channelType];
                contextMessage += `${index + 1}. ${channelType.toUpperCase()}\n`;
                contextMessage += `   ├─ Type: ${channelDetails.type}\n`;
                contextMessage += `   ├─ Description: ${channelDetails.description}\n`;
                if (channelDetails.email) {
                    contextMessage += `   ├─ Email: ${channelDetails.email}\n`;
                }
                if (channelDetails.aliases && channelDetails.aliases.length > 0) {
                    contextMessage += `   ├─ Aliases: ${channelDetails.aliases.join(', ')}\n`;
                }
                if (channelDetails.phone_number) {
                    contextMessage += `   ├─ Phone: ${channelDetails.phone_number}\n`;
                }
                if (channelDetails.number) {
                    contextMessage += `   ├─ Number: ${channelDetails.number}\n`;
                }
                if (channelDetails.enabled !== undefined) {
                    contextMessage += `   ├─ Enabled: ${channelDetails.enabled}\n`;
                }
                if (channelDetails.platforms) {
                    const platforms = Object.entries(channelDetails.platforms)
                        .filter(([_, url]) => url)
                        .map(([platform, url]) => `${platform}: ${url}`)
                        .join(', ');
                    if (platforms) {
                        contextMessage += `   ├─ Platforms: ${platforms}\n`;
                    }
                }
                contextMessage += `   └─ Available for lead contact\n\n`;
            });
        }
        else {
            contextMessage += `⚠️ WARNING: Site has NO channels configured!\n`;
            contextMessage += `   This will severely limit contact recommendations.\n`;
            if (siteChannelsConfig.warning) {
                contextMessage += `   Details: ${siteChannelsConfig.warning}\n`;
            }
            contextMessage += `\n`;
        }
        contextMessage += `=== ANALYSIS INSTRUCTIONS ===\n\n`;
        contextMessage += `As a Sales/CRM Specialist, analyze the provided leads and provide strategic recommendations for:\n\n`;
        contextMessage += `1. CONTACT PRIORITY: For each company with multiple leads, determine which lead should be contacted FIRST and why\n`;
        contextMessage += `2. STRATEGIC ACCOUNT ASSIGNMENTS: Identify ONLY the most high-value companies that truly require dedicated team member assignment\n`;
        contextMessage += `3. CONTACT STRATEGY: Recommend the best approach for each priority lead\n\n`;
        contextMessage += `CRITICAL CHANNEL RESTRICTIONS:\n`;
        if (siteChannelsConfig.hasChannels) {
            contextMessage += `- ONLY use channels that are configured for this site: ${siteChannelsConfig.configuredChannels.join(', ')}\n`;
            contextMessage += `- DO NOT recommend channels that are not configured for this site\n`;
            contextMessage += `- When a lead has multiple contact methods (email, phone, etc.), prioritize channels that the site has configured\n`;
            contextMessage += `- If a lead's preferred channel is not configured, suggest the best alternative from available channels\n`;
        }
        else {
            contextMessage += `- ⚠️ CRITICAL: Site has NO channels configured! Contact recommendations will be severely limited\n`;
            contextMessage += `- Recommend that the site configure at least one communication channel before implementing contact strategies\n`;
            contextMessage += `- Focus on lead prioritization and preparation rather than specific contact methods\n`;
        }
        contextMessage += `\n`;
        contextMessage += `CRITICAL ASSIGNMENT GUIDELINES:\n`;
        contextMessage += `- DO NOT assign ALL leads to team members\n`;
        contextMessage += `- ONLY assign leads from companies that represent significant strategic value (top 20-30% of accounts)\n`;
        contextMessage += `- Prioritize assigning team members who have proven success in specific segments based on attribution data\n`;
        contextMessage += `- Consider the team member's track record with similar companies/segments when making assignments\n`;
        contextMessage += `- Leave lower-value or routine leads unassigned for general team handling\n\n`;
        contextMessage += `STRICT ROLE RESTRICTIONS (Multilingual):\n`;
        contextMessage += `- EN: Do NOT assign leads to external consultants, contractors, freelancers, vendors, or external collaborators unless their role is Sales, SDR, or BDR.\n`;
        contextMessage += `- ES: NO asignes leads a consultores externos, contratistas, freelancers, proveedores o colaboradores externos salvo que su rol sea Vendedor, SDR o BDR.\n`;
        contextMessage += `- PT: NÃO atribua leads a consultores externos, contratados, freelancers, fornecedores ou colaboradores externos, a menos que o cargo seja Vendas, SDR ou BDR.\n`;
        contextMessage += `- FR: N'ASSIGNEZ PAS de leads à des consultants externes, sous-traitants, freelances, fournisseurs ou collaborateurs externes sauf si leur rôle est Ventes, SDR ou BDR.\n`;
        contextMessage += `- IT: NON assegnare lead a consulenti esterni, contractor, freelancer, fornitori o collaboratori esterni, salvo che il ruolo sia Vendite, SDR o BDR.\n`;
        contextMessage += `- DE: Weisen Sie KEINE Leads an externe Berater, Auftragnehmer, Freelancer, Anbieter oder externe Mitarbeiter zu, außer ihre Rolle ist Vertrieb, SDR oder BDR.\n`;
        contextMessage += `- Synonyms: external consultant, contractor, freelancer, vendor, collaborator, outsource, third-party.\n`;
        contextMessage += `- Allowed roles: sales_agent, seller, SDR, BDR only.\n\n`;
        contextMessage += `Consider these factors in your analysis:\n`;
        contextMessage += `- Historical conversion patterns from segment data provided\n`;
        contextMessage += `- Team member attribution success rates by segment\n`;
        contextMessage += `- Recent activity and engagement level\n`;
        contextMessage += `- Lead scores and qualification status\n`;
        contextMessage += `- Company size and potential value\n`;
        contextMessage += `- Existing relationships and conversation history\n`;
        contextMessage += `- Task completion status and follow-up needs\n`;
        contextMessage += `- Patterns from converted vs lost leads in same segments\n`;
        contextMessage += `- Available site communication channels and their capabilities\n`;
        contextMessage += `- Lead contact preferences vs site channel availability\n\n`;
        contextMessage += `Priority Factors Configuration:\n`;
        contextMessage += `- Recent Activity Weight: ${priorityFactors.recentActivity}\n`;
        contextMessage += `- Company Size Weight: ${priorityFactors.companySize}\n`;
        contextMessage += `- Engagement Weight: ${priorityFactors.engagement}\n`;
        contextMessage += `- Lead Score Weight: ${priorityFactors.leadScore}\n\n`;
        contextMessage += `SEGMENT PERFORMANCE INSIGHTS:\n`;
        contextMessage += `Use the provided converted and lost leads data to understand:\n`;
        contextMessage += `- Which segments have higher conversion rates\n`;
        contextMessage += `- What attribution factors led to successful conversions\n`;
        contextMessage += `- Common patterns in lost leads to avoid\n`;
        contextMessage += `- Which team members excel in specific segments\n\n`;
        console.log(`🚀 Creando comando de selección de leads`);
        const leadSelectionCommand = CommandFactory.createCommand({
            task: 'lead selection analysis',
            userId: effectiveUserId,
            agentId: effectiveAgentId,
            agentRole: 'Sales/CRM Specialist',
            site_id: siteId,
            description: `Analyze ${leadsData.length} leads across ${companiesMap.size} companies to determine contact priority and team assignments. Focus on identifying the most strategic leads to contact first within each company and which accounts warrant dedicated team member assignment.`,
            targets: [
                {
                    strategic_analysis: "Comprehensive analysis of all leads considering company context, engagement history, and business potential"
                },
                {
                    priority_leads: [
                        {
                            company: "Company name",
                            primary_lead_id: "ID of the lead to contact first",
                            primary_lead_name: "Name of the primary contact",
                            priority_score: "Priority score (1-100)",
                            reasoning: "Why this lead should be contacted first"
                        }
                    ]
                },
                {
                    important_accounts: [
                        {
                            company: "Company name",
                            lead_id: "Lead ID for assignment",
                            recommended_assignee_id: "Team member ID or 'unspecified'",
                            recommended_assignee_name: "Team member name or 'To be determined'",
                            account_value: "High/Medium/Low",
                            assignment_reasoning: "Why this account needs dedicated assignment"
                        }
                    ]
                },
                {
                    contact_recommendations: [
                        {
                            lead_id: "Lead ID",
                            company: "Company name",
                            contact_strategy: "Recommended approach for first contact",
                            urgency: "High/Medium/Low",
                            key_talking_points: "Main points to address"
                        }
                    ]
                }
            ],
            context: contextMessage,
            supervisor: [
                {
                    agent_role: 'sales_manager',
                    status: 'not_initialized'
                },
                {
                    agent_role: 'account_manager',
                    status: 'not_initialized'
                }
            ]
        });
        const commandId = await commandService.submitCommand(leadSelectionCommand);
        console.log(`📝 Comando de selección de leads creado con ID interno: ${commandId}`);
        console.log(`⏳ Esperando que se complete el análisis de selección de leads...`);
        const { command: completedCommand, dbUuid, completed } = await waitForCommandCompletion(commandId);
        if (!completed || !completedCommand) {
            console.error(`❌ El comando de selección de leads no se completó correctamente`);
            return NextResponse.json({
                success: false,
                error: {
                    code: 'COMMAND_FAILED',
                    message: 'Lead selection analysis did not complete successfully'
                }
            }, { status: 500 });
        }
        console.log(`✅ Comando de selección de leads completado exitosamente`);
        let priorityLeads = [];
        let importantAccounts = [];
        let contactRecommendations = [];
        let strategicAnalysis = '';
        if (completedCommand.results && Array.isArray(completedCommand.results)) {
            for (const result of completedCommand.results) {
                if (result.strategic_analysis) {
                    strategicAnalysis = result.strategic_analysis;
                }
                if (result.priority_leads && Array.isArray(result.priority_leads)) {
                    priorityLeads = result.priority_leads;
                }
                if (result.important_accounts && Array.isArray(result.important_accounts)) {
                    importantAccounts = result.important_accounts;
                }
                if (result.contact_recommendations && Array.isArray(result.contact_recommendations)) {
                    contactRecommendations = result.contact_recommendations;
                }
            }
        }
        console.log(`📊 Resultados extraídos - Priority Leads: ${priorityLeads.length}, Important Accounts: ${importantAccounts.length}, Contact Recommendations: ${contactRecommendations.length}`);
        return NextResponse.json({
            success: true,
            data: {
                analysis: {
                    total_leads_analyzed: leadsData.length,
                    companies_analyzed: companiesMap.size,
                    strategic_analysis: strategicAnalysis
                },
                priority_leads: priorityLeads,
                important_accounts: importantAccounts,
                contact_recommendations: contactRecommendations,
                team_members: teamMembers,
                site_channels: {
                    has_channels: siteChannelsConfig.hasChannels,
                    configured_channels: siteChannelsConfig.configuredChannels,
                    channels_details: siteChannelsConfig.channelsDetails,
                    warning: siteChannelsConfig.warning
                },
                command_info: {
                    command_id: commandId,
                    db_uuid: dbUuid
                }
            }
        });
    }
    catch (error) {
        console.error('Error general en la ruta de selección de leads:', error);
        return NextResponse.json({
            success: false,
            error: {
                code: 'SYSTEM_ERROR',
                message: 'An internal system error occurred'
            }
        }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
