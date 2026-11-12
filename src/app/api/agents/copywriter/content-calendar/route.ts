import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getContentRequirementsContext } from '@/lib/helpers/content-requirements-helper';
import { isValidUUID, findContentCreatorAgent, findGrowthMarketerAgent, saveContentItemsToDatabase, commandService, getCommandDbUuid, waitForCommandCompletion } from './command-helpers-1';
import { buildContext, executeGrowthMarketerPlanning } from './command-helpers-2';
async function handleCommandRequest(request: Request) {
    try {
        const body = await request.json();
        const { siteId, segmentId, campaignId, userId, agent_id, timeframe, contentType, targetAudience, goals, keywords } = body;
        if (!siteId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } }, { status: 400 });
        }
        if (!isValidUUID(siteId)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId must be a valid UUID' } }, { status: 400 });
        }
        const growthMarketerAgent = await findGrowthMarketerAgent(siteId);
        if (!growthMarketerAgent) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'GROWTH_MARKETER_NOT_FOUND',
                    message: 'No se encontró un agente con rol "Growth Marketer" para este sitio'
                }
            }, { status: 404 });
        }
        console.log(`🎯 Growth Marketer encontrado: ${growthMarketerAgent.agentId}`);
        let effectiveUserId = userId || growthMarketerAgent.userId;
        if (!effectiveUserId) {
            effectiveUserId = 'system';
        }
        const context = await buildContext(siteId, segmentId, campaignId);
        let additionalContext = [];
        if (timeframe) {
            additionalContext.push(`TIMEFRAME: ${timeframe}`);
        }
        if (contentType) {
            const formattedContentTypes = Array.isArray(contentType)
                ? contentType.join(', ')
                : contentType;
            additionalContext.push(`CONTENT TYPES: ${formattedContentTypes}`);
        }
        if (targetAudience) {
            const formattedAudience = Array.isArray(targetAudience)
                ? targetAudience.join(', ')
                : targetAudience;
            additionalContext.push(`TARGET AUDIENCE: ${formattedAudience}`);
        }
        if (goals && Array.isArray(goals) && goals.length > 0) {
            additionalContext.push(`BUSINESS & MARKETING GOALS:`);
            goals.forEach((goal, index) => {
                additionalContext.push(`  ${index + 1}. ${goal}`);
            });
        }
        if (keywords && Array.isArray(keywords) && keywords.length > 0) {
            additionalContext.push(`FOCUS KEYWORDS & TOPICS:`);
            const groupedKeywords = [];
            for (let i = 0; i < keywords.length; i += 5) {
                const group = keywords.slice(i, i + 5).join(', ');
                groupedKeywords.push(`  • ${group}`);
            }
            additionalContext.push(groupedKeywords.join('\n'));
        }
        console.log(`📊 INICIANDO PASO 1: Ejecutando planificación estratégica con Growth Marketer...`);
        console.log(`⚠️ IMPORTANTE: NO se enviará respuesta al cliente hasta completar AMBOS comandos + guardado`);
        const growthPlanningResults = await executeGrowthMarketerPlanning(siteId, growthMarketerAgent.agentId, effectiveUserId, context, additionalContext);
        if (!growthPlanningResults || growthPlanningResults.length === 0) {
            console.log(`❌ FALLO EN PASO 1: Growth Marketer planning falló - enviando error response`);
            return NextResponse.json({
                success: false,
                error: {
                    code: 'GROWTH_PLANNING_FAILED',
                    message: 'No se pudo obtener la planificación estratégica del Growth Marketer'
                }
            }, { status: 500 });
        }
        console.log(`✅ PASO 1 COMPLETADO: Planificación estratégica completada con ${growthPlanningResults.length} recomendaciones`);
        console.log(`🔄 CONTINUANDO PASO 2: Iniciando creación de contenido con Copywriter...`);
        let effectiveAgentId = agent_id;
        if (!effectiveAgentId) {
            const foundAgent = await findContentCreatorAgent(siteId);
            if (foundAgent) {
                effectiveAgentId = foundAgent.agentId;
                console.log(`🤖 Usando agente con rol "Content Creator & Copywriter" encontrado: ${effectiveAgentId}`);
            }
            else {
                effectiveAgentId = 'default_copywriter_agent';
                console.log(`🤖 No se encontró agente específico, usando agente por defecto: ${effectiveAgentId}`);
            }
        }
        console.log(`Creating content generation command for agent: ${effectiveAgentId}, site: ${siteId}`);
        const growthPlanningContext = `
GROWTH MARKETER STRATEGIC PLANNING RESULTS:
The following strategic content plan has been developed by our Growth Marketer. Use this as the foundation for creating the actual content pieces:

${growthPlanningResults.map((plan, index) => `
CONTENT PIECE ${index + 1}:
- Strategic Rationale: ${plan.strategic_rationale || 'N/A'}
- Content Topic: ${plan.content_topic || 'N/A'}
- Recommended Type: ${plan.content_type || 'N/A'}
- Target Audience: ${plan.target_audience || 'N/A'}
- Key Messages: ${plan.key_messages || 'N/A'}
- Publishing Timing: ${plan.publishing_timing || 'N/A'}
- Distribution Channels: ${plan.distribution_channels || 'N/A'}
- Success Metrics: ${plan.success_metrics || 'N/A'}
- SEO Keywords: ${plan.seo_keywords || 'N/A'}
`).join('\n')}

IMPORTANT: Follow the Growth Marketer's strategic recommendations above as the foundation for your content creation.
`;
        const baseContextTemplate = `Generate a strategic content calendar optimized for maximum business impact based on the Growth Marketer's strategic planning.

ROLE: Content Creator & Copywriter - Focus on creating compelling, high-quality content based on strategic direction
OBJECTIVE: Create detailed, ready-to-publish content pieces that align with the Growth Marketer's strategic plan

CAMPAIGN SCOPE:
You are creating content for multiple active campaigns. When content is specifically for a campaign, include the campaign_id from the requirements section. Each content piece should align with the relevant campaign strategy when applicable.

CONTENT CREATION REQUIREMENTS:
- PRIORITIZE addressing active content requirements from ongoing campaigns (see requirements section below)
- Follow the strategic guidance provided by the Growth Marketer
- Create compelling, high-quality content that resonates with the target audience
- Ensure each content piece aligns with the specified business goals and messaging
- Develop content that supports the recommended distribution channels
- Include proper SEO optimization based on the strategic keyword recommendations
- Create content that can be measured against the specified success metrics
- Reference requirement IDs in your instructions when content addresses specific requirements
- When content is for a specific campaign, include the campaign_id in your content structure

CONTENT TYPE OPTIONS (AUTHORIZED VALUES ONLY):
Choose from ONLY these authorized values: blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page

TYPE DESCRIPTIONS:
- blog_post: Blog Post
- video: Video content
- podcast: Podcast episode
- social_post: Social Media Post
- newsletter: Newsletter content
- case_study: Case Study
- whitepaper: Whitepaper
- infographic: Infographic
- webinar: Webinar content
- ebook: E-Book
- ad: Advertisement
- landing_page: Landing Page (only if required by the business goals)

CONTENT STRUCTURE GUIDELINES:
1. Create content pieces based on the Growth Marketer's strategic recommendations
2. For each content item include:
   - Clear, compelling title (50-60 characters)
   - Concise but descriptive summary (100-150 characters)
   - Content type/format (follow Growth Marketer's recommendations when possible)
   - Primary topic and 3-5 related keywords (use strategic keywords provided)
   - Estimated reading/viewing time in seconds
   - Optimal publishing date or timeframe (follow timing recommendations)
   - Specific target audience segment (use Growth Marketer's targeting)
   - Business goal this content supports (align with strategic rationale)
   - Brief strategic notes on execution
   - Campaign ID reference (when content is for a specific campaign)

CONTENT OUTPUT FORMAT:
Split your response into TWO SEPARATE FIELDS:

1. "text" field: ONLY the final copy/content ready to be published
   - Rich markdown detailed copy, add line breaks for readability and formatting
   - Be creative and engaging
   - NO strategic notes, NO distribution info, NO SEO keywords lists
   - ONLY the actual content that readers will see

2. "instructions" field: ALL strategic and tactical information in markdown format
   - Distribution guidelines and channel recommendations
   - SEO keywords and optimization notes
   - Target audience segments and conversion goals
   - Repurposing opportunities and dependencies
   - Execution details and tactical notes for marketers
   - Publishing schedule and strategic rationale
   - Alignment with Growth Marketer's strategic plan

CRITICAL: Keep these completely separate. The "text" should be clean copy without any meta-information.

${growthPlanningContext}

${context}`;
        const fullContext = additionalContext.length > 0
            ? `${baseContextTemplate}\n\nAdditional Parameters:\n${additionalContext.join('\n')}`
            : baseContextTemplate;
        const command = CommandFactory.createCommand({
            task: 'create content copywriting',
            userId: effectiveUserId,
            agentId: effectiveAgentId,
            agentRole: 'Content Creator & Copywriter',
            ...(siteId ? { site_id: siteId } : {}),
            ...(campaignId ? { campaign_id: campaignId } : {}),
            description: 'Generate a comprehensive content calendar with strategic content ideas aligned with marketing goals, focused on the target audience, and optimized for the specified keywords and timeframe.',
            targets: [
                {
                    deep_thinking: "Write a deep thinking reasoning about the content to be created",
                },
                ...(campaignId ? [{ campaign_id: campaignId }] : []),
                {
                    content: [{
                            type: "Type of content from ONLY these authorized values: blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page. Choose the most appropriate type for each content piece.",
                            text: "Rich detailed copy with proper formatting and line breaks for readability",
                            title: "Clear, compelling title for the content piece",
                            description: "Brief, descriptive summary of the content",
                            instructions: "Strategic instructions, notes, distribution guidelines, SEO considerations, and execution details for this content piece in markdown format",
                            estimated_reading_time: "Reading time in seconds as integer (e.g., 60, 120, 240)",
                            campaign_id: "Campaign ID if content is for a specific campaign (optional)"
                        }]
                }
            ],
            context: fullContext,
            supervisor: [
                {
                    agent_role: 'growth_marketer',
                    status: 'not_initialized'
                },
                {
                    agent_role: 'growth_manager',
                    status: 'not_initialized'
                }
            ]
        });
        console.log(`📝 PASO 2: Ejecutando comando de Content Creator & Copywriter...`);
        const internalCommandId = await commandService.submitCommand(command);
        console.log(`📝 Content Creator command created with internal ID: ${internalCommandId}`);
        let initialDbUuid = await getCommandDbUuid(internalCommandId);
        if (initialDbUuid) {
            console.log(`📌 Database UUID obtained initially: ${initialDbUuid}`);
        }
        const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
        let effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
        if (!effectiveDbUuid || !isValidUUID(effectiveDbUuid)) {
            console.error(`❌ Could not obtain a valid database UUID for command ${internalCommandId}`);
            console.log(`⚠️ Using internal ID as fallback: ${internalCommandId}`);
            effectiveDbUuid = internalCommandId;
        }
        if (!completed || !executedCommand) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'COMMAND_EXECUTION_FAILED',
                    message: 'The command did not complete successfully in the expected time'
                }
            }, { status: 500 });
        }
        let contentResults = [];
        console.log(`🔍 Debug: executedCommand.results structure:`, JSON.stringify(executedCommand.results, null, 2));
        if (executedCommand.results && Array.isArray(executedCommand.results)) {
            for (const result of executedCommand.results) {
                if (result.content && Array.isArray(result.content)) {
                    contentResults = result.content;
                    console.log(`✅ Found content array with ${contentResults.length} items`);
                    break;
                }
            }
            if (contentResults.length === 0) {
                console.log(`⚠️ No content found. Available result keys:`, executedCommand.results.map((r: any) => Object.keys(r)).flat());
            }
        }
        console.log(`📊 Generated ${contentResults.length} content items`);
        let savedContentItems = [];
        let savedToDatabase = false;
        if (contentResults.length > 0) {
            try {
                savedContentItems = await saveContentItemsToDatabase(contentResults, siteId, effectiveDbUuid || internalCommandId, segmentId, campaignId, effectiveUserId);
                savedToDatabase = savedContentItems && savedContentItems.length > 0;
            }
            catch (error) {
                console.error('Failed to save content to database:', error);
                savedToDatabase = false;
                savedContentItems = [];
            }
        }
        const responseContent = savedContentItems.length > 0 ? savedContentItems : contentResults;
        console.log(`🎉 PROCESO COMPLETO: Enviando respuesta SUCCESS al cliente después de ambos comandos + guardado`);
        console.log(`📊 Resumen final: ${responseContent.length} contenidos creados, guardados en DB: ${savedToDatabase}`);
        return NextResponse.json({
            success: true,
            data: {
                command_id: effectiveDbUuid || internalCommandId,
                siteId,
                segmentId,
                campaignId,
                content: responseContent,
                saved_to_database: savedToDatabase
            }
        }, { status: 200 });
    }
    catch (error) {
        console.error('Error processing request:', error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
