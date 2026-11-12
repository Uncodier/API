import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { getLeadInfo, getPreviousInteractions, buildEnrichedContext, safeStringify } from '@/lib/helpers/lead-context-helper';
import { isValidUUID, commandService, getCommandDbUuid, waitForCommandCompletion, getAgentInfo } from './command-helpers-1';
async function handleCommandRequest(request: Request) {
    try {
        const body = await request.json();
        const { site_id, lead_id, userId, agent_id, researchDepth = "standard", researchAreas, includeSocialMedia = false, includeCompetitorAnalysis = false, includeFinancialInfo = false } = body;
        if (!site_id) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } }, { status: 400 });
        }
        if (!lead_id) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'lead_id is required' } }, { status: 400 });
        }
        let agentInfo: any = null;
        let effectiveUserId = userId;
        if (agent_id) {
            agentInfo = await getAgentInfo(agent_id);
            if (!agentInfo) {
                return NextResponse.json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } }, { status: 404 });
            }
            if (!effectiveUserId) {
                effectiveUserId = agentInfo.user_id;
            }
        }
        if (!effectiveUserId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required if agent_id is not provided' } }, { status: 400 });
        }
        const leadInfo = await getLeadInfo(lead_id);
        if (!leadInfo) {
            return NextResponse.json({ success: false, error: { code: 'LEAD_NOT_FOUND', message: 'The specified lead was not found' } }, { status: 404 });
        }
        const previousInteractions = await getPreviousInteractions(lead_id);
        let contextMessage = `Lead Research Request\nLead ID: ${lead_id}\nSite ID: ${site_id}\n`;
        contextMessage += `\nLead Information:`;
        if (leadInfo.name)
            contextMessage += `\nName: ${leadInfo.name}`;
        if (leadInfo.company)
            contextMessage += `\nCompany: ${safeStringify(leadInfo.company)}`;
        if (leadInfo.position)
            contextMessage += `\nPosition: ${leadInfo.position}`;
        if (leadInfo.email)
            contextMessage += `\nEmail: ${leadInfo.email}`;
        if (leadInfo.phone)
            contextMessage += `\nPhone: ${leadInfo.phone}`;
        if (leadInfo.location)
            contextMessage += `\nLocation: ${leadInfo.location}`;
        if (leadInfo.pain_points) {
            if (Array.isArray(leadInfo.pain_points)) {
                contextMessage += `\nPain Points: ${leadInfo.pain_points.join(', ')}`;
            }
            else {
                contextMessage += `\nPain Points: ${leadInfo.pain_points}`;
            }
        }
        if (leadInfo.budget_range) {
            contextMessage += `\nBudget Range: ${leadInfo.budget_range}`;
        }
        if (leadInfo.sites) {
            contextMessage += `\nSite: ${leadInfo.sites.name} (${leadInfo.sites.url})`;
        }
        if (leadInfo.visitors) {
            if (leadInfo.visitors.user_agent) {
                contextMessage += `\nUser Agent: ${leadInfo.visitors.user_agent}`;
            }
        }
        if (previousInteractions && previousInteractions.length > 0) {
            contextMessage += `\n\nPrevious Interactions:`;
            previousInteractions.forEach((interaction: any, index: number) => {
                contextMessage += `\n${index + 1}. Date: ${interaction.date || interaction.created_at}`;
                contextMessage += `\n   Type: ${interaction.type || 'Unknown'}`;
                contextMessage += `\n   Summary: ${interaction.summary || interaction.content || 'No summary available'}`;
                if (index < previousInteractions.length - 1) {
                    contextMessage += `\n`;
                }
            });
        }
        contextMessage += `\n\nResearch Configuration:`;
        contextMessage += `\nDepth: ${researchDepth}`;
        contextMessage += `\nInclude Social Media: ${includeSocialMedia ? 'Yes' : 'No'}`;
        contextMessage += `\nInclude Competitor Analysis: ${includeCompetitorAnalysis ? 'Yes' : 'No'}`;
        contextMessage += `\nInclude Financial Information: ${includeFinancialInfo ? 'Yes' : 'No'}`;
        if (researchAreas && Array.isArray(researchAreas) && researchAreas.length > 0) {
            contextMessage += `\nSpecific Research Areas: ${researchAreas.join(', ')}`;
        }
        console.log(`🔍 Construyendo contexto enriquecido para el comando...`);
        const enrichedContext = await buildEnrichedContext(site_id, lead_id);
        if (enrichedContext) {
            contextMessage += `\n\n${enrichedContext}`;
            console.log(`✅ Contexto enriquecido añadido (${enrichedContext.length} caracteres)`);
        }
        else {
            console.log(`⚠️ No se pudo obtener contexto enriquecido`);
        }
        const command = CommandFactory.createCommand({
            task: 'conduct comprehensive lead research',
            userId: effectiveUserId,
            agentId: agent_id,
            agentRole: 'Sales/CRM Specialist',
            site_id: site_id,
            description: 'Conduct comprehensive research on a lead to gather valuable insights for sales and marketing strategies. Include company background, key personnel, recent news, competitive landscape, and potential pain points.',
            targets: [
                {
                    title: "Company Background Research",
                    message: "Detailed research on the lead's company including industry, size, revenue, business model, and key services/products",
                    channel: "research"
                },
                {
                    title: "Key Personnel Analysis",
                    message: "Information about key decision makers, their roles, background, and recent activities",
                    channel: "research"
                },
                {
                    title: "Recent Company News & Updates",
                    message: "Latest news, press releases, funding rounds, partnerships, or significant company changes",
                    channel: "research"
                },
                {
                    title: "Pain Points & Challenges Identification",
                    message: "Analysis of potential challenges, pain points, and business needs based on available information",
                    channel: "research"
                },
                {
                    title: "Competitive Landscape Analysis",
                    message: "Information about the company's competitors, market position, and differentiation factors",
                    channel: "research"
                },
                {
                    title: "Engagement Recommendations",
                    message: "Strategic recommendations for how to approach and engage with this lead based on research findings",
                    channel: "recommendations"
                }
            ],
            context: contextMessage,
            supervisor: [
                {
                    agent_role: 'sales_manager',
                    status: 'not_initialized'
                },
                {
                    agent_role: 'research_analyst',
                    status: 'not_initialized'
                }
            ],
            modelType: 'openrouter'
        });
        const internalCommandId = await commandService.submitCommand(command);
        console.log(`📝 Comando de investigación de lead creado con ID interno: ${internalCommandId}`);
        let initialDbUuid = await getCommandDbUuid(internalCommandId);
        if (initialDbUuid) {
            console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
        }
        const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
        const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
        if (!completed) {
            console.warn(`⚠️ Comando ${internalCommandId} no completó exitosamente en el tiempo esperado`);
            if (!executedCommand || !executedCommand.results || executedCommand.results.length === 0) {
                return NextResponse.json({
                    success: false,
                    error: {
                        code: 'RESEARCH_EXECUTION_FAILED',
                        message: 'El comando de investigación no completó exitosamente y no se generaron resultados válidos'
                    }
                }, { status: 500 });
            }
            else {
                console.log(`⚠️ Comando en estado ${executedCommand.status} pero tiene ${executedCommand.results.length} resultados, continuando`);
            }
        }
        let researchResults: any[] = [];
        if (executedCommand.results && Array.isArray(executedCommand.results) && executedCommand.results.length > 0) {
            executedCommand.results.forEach((result: any) => {
                if (result.title && result.message && result.channel) {
                    researchResults.push({
                        title: result.title,
                        content: result.message,
                        category: result.channel,
                        type: 'research_finding',
                        generated_at: new Date().toISOString()
                    });
                }
                else if (result.content && result.content.title && result.content.message && result.content.channel) {
                    researchResults.push({
                        title: result.content.title,
                        content: result.content.message,
                        category: result.content.channel,
                        type: 'research_finding',
                        generated_at: new Date().toISOString()
                    });
                }
            });
        }
        const savedResearch: any[] = [];
        for (const researchResult of researchResults) {
            try {
                const researchData = {
                    site_id: site_id,
                    lead_id: lead_id,
                    user_id: effectiveUserId,
                    agent_id: agent_id,
                    title: researchResult.title,
                    content: researchResult.content,
                    category: researchResult.category,
                    research_type: researchDepth,
                    status: 'completed',
                    command_id: effectiveDbUuid || internalCommandId,
                    metadata: {
                        include_social_media: includeSocialMedia,
                        include_competitor_analysis: includeCompetitorAnalysis,
                        include_financial_info: includeFinancialInfo,
                        research_areas: researchAreas || [],
                        generated_at: researchResult.generated_at
                    }
                };
                const { data, error } = await supabaseAdmin
                    .from('lead_research')
                    .insert([researchData])
                    .select()
                    .single();
                if (error) {
                    console.error('Error al guardar resultado de investigación:', error);
                }
                else if (data) {
                    savedResearch.push(data);
                }
            }
            catch (saveError) {
                console.error('Error al guardar resultado de investigación:', saveError);
            }
        }
        return NextResponse.json({
            success: true,
            data: {
                command_id: effectiveDbUuid || internalCommandId,
                site_id,
                lead_id,
                research_results: savedResearch.length > 0 ? savedResearch : researchResults,
                saved_to_database: savedResearch.length > 0,
                research_configuration: {
                    depth: researchDepth,
                    include_social_media: includeSocialMedia,
                    include_competitor_analysis: includeCompetitorAnalysis,
                    include_financial_info: includeFinancialInfo,
                    research_areas: researchAreas || []
                }
            }
        });
    }
    catch (error) {
        console.error('Error general en la ruta de investigación de leads:', error);
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
