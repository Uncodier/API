import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getContentRequirementsContext } from '@/lib/helpers/content-requirements-helper';
import { isValidUUID, commandService, waitForCommandCompletion, getSegmentInfo, getCampaignInfo } from './command-helpers-1';
export async function getSiteInfo(siteId: string): Promise<any | null> {
    try {
        if (!isValidUUID(siteId)) {
            console.log(`Invalid site ID: ${siteId}`);
            return null;
        }
        const { data, error } = await supabaseAdmin
            .from('sites')
            .select('*')
            .eq('id', siteId)
            .single();
        if (error) {
            console.error(`Error fetching site info: ${error.message}`);
            return null;
        }
        return data;
    }
    catch (error) {
        console.error('Error getting site info:', error);
        return null;
    }
}
export async function buildContext(siteId: string, segmentId?: string, campaignId?: string): Promise<string> {
    let contextParts = [];
    console.log(`🔍 [buildContext] Obteniendo requirements para site: ${siteId} (todas las campañas activas)`);
    const contentRequirementsContext = await getContentRequirementsContext(siteId);
    console.log(`🔍 [buildContext] contentRequirementsContext resultado:`, {
        length: contentRequirementsContext?.length || 0,
        hasContent: !!contentRequirementsContext,
        preview: contentRequirementsContext?.substring(0, 100) || 'EMPTY'
    });
    if (contentRequirementsContext) {
        contextParts.push(contentRequirementsContext);
        console.log(`✅ [buildContext] Requirements context agregado a contextParts (${contentRequirementsContext.length} caracteres)`);
    }
    else {
        console.log(`⚠️ [buildContext] NO se agregó requirements context - está vacío`);
    }
    if (segmentId) {
        const segmentInfo = await getSegmentInfo(segmentId);
        if (segmentInfo) {
            const segmentData = {
                name: segmentInfo.name || 'Unnamed Segment',
                description: segmentInfo.description || 'No description available',
                audience_criteria: segmentInfo.criteria || segmentInfo.audience_criteria || 'N/A',
                size: segmentInfo.size || segmentInfo.audience_size || 'Unknown',
                interests: segmentInfo.interests || [],
                pain_points: segmentInfo.pain_points || []
            };
            contextParts.push(`AUDIENCE SEGMENT INFORMATION:
- Name: ${segmentData.name}
- Description: ${segmentData.description}
- Criteria: ${segmentData.audience_criteria}
- Segment Size: ${segmentData.size}
${Array.isArray(segmentData.interests) && segmentData.interests.length > 0 ? `- Interests: ${segmentData.interests.join(', ')}` : ''}
${Array.isArray(segmentData.pain_points) && segmentData.pain_points.length > 0 ? `- Pain Points: ${segmentData.pain_points.join(', ')}` : ''}
${segmentInfo.behaviors ? `- Key Behaviors: ${segmentInfo.behaviors}` : ''}
${segmentInfo.content_preferences ? `- Content Preferences: ${segmentInfo.content_preferences}` : ''}`);
        }
        else {
            contextParts.push(`AUDIENCE SEGMENT INFORMATION:\n- Segment ID: ${segmentId}\n- Note: No additional segment information available`);
        }
    }
    if (campaignId) {
        const campaignInfo = await getCampaignInfo(campaignId);
        if (campaignInfo) {
            const campaignData = {
                name: campaignInfo.name || 'Unnamed Campaign',
                description: campaignInfo.description || 'No description available',
                goal: campaignInfo.goal || campaignInfo.objective || 'N/A',
                start_date: campaignInfo.start_date || 'N/A',
                end_date: campaignInfo.end_date || 'N/A',
                target_audience: campaignInfo.target_audience || 'N/A',
                channels: campaignInfo.channels || [],
                kpis: campaignInfo.kpis || []
            };
            contextParts.push(`CAMPAIGN INFORMATION:
- Name: ${campaignData.name}
- Description: ${campaignData.description}
- Primary Goal: ${campaignData.goal}
- Timeline: ${campaignData.start_date} to ${campaignData.end_date}
- Target Audience: ${campaignData.target_audience}
${Array.isArray(campaignData.channels) && campaignData.channels.length > 0 ? `- Distribution Channels: ${campaignData.channels.join(', ')}` : ''}
${Array.isArray(campaignData.kpis) && campaignData.kpis.length > 0 ? `- Key Performance Indicators: ${campaignData.kpis.join(', ')}` : ''}
${campaignInfo.budget ? `- Budget: ${campaignInfo.budget}` : ''}
${campaignInfo.messaging ? `- Key Messaging: ${campaignInfo.messaging}` : ''}
${campaignInfo.content_requirements ? `- Content Requirements: ${campaignInfo.content_requirements}` : ''}`);
        }
        else {
            contextParts.push(`CAMPAIGN INFORMATION:\n- Campaign ID: ${campaignId}\n- Note: No additional campaign information available`);
        }
    }
    return contextParts.join('\n\n');
}
export async function executeGrowthMarketerPlanning(siteId: string, agentId: string, userId: string, context: string, additionalContext: string[]): Promise<any[] | null> {
    try {
        console.log(`📊 Ejecutando comando de planificación con Growth Marketer: ${agentId}`);
        console.log(`🔍 [executeGrowthMarketerPlanning] Obteniendo requirements para site: ${siteId} (todas las campañas activas)`);
        const contentRequirementsContext = await getContentRequirementsContext(siteId);
        console.log(`🔍 [executeGrowthMarketerPlanning] contentRequirementsContext resultado:`, {
            length: contentRequirementsContext?.length || 0,
            hasContent: !!contentRequirementsContext,
            preview: contentRequirementsContext?.substring(0, 100) || 'EMPTY'
        });
        const growthMarketerPrompt = `Create a strategic content calendar plan focused on business growth and marketing objectives.

ROLE: Growth Marketer - Focus on strategy, audience targeting, and business impact
OBJECTIVE: Develop a comprehensive content planning strategy that maximizes ROI and supports business goals

CAMPAIGN SCOPE:
You are creating content for multiple active campaigns for this site. Each content piece should be aligned with specific campaign requirements when applicable. Include campaign IDs when content is specifically targeted to a campaign.

PLANNING REQUIREMENTS:
- Analyze target audience segments and create content that drives engagement
- Identify content types that will perform best for each business objective
- Plan content distribution and timing for maximum impact
- Consider content funnel strategy (awareness, consideration, decision)
- Include performance metrics and KPIs for each content piece
- Plan content themes and campaigns that build on each other
- Consider seasonal opportunities and trending topics
- Balance evergreen vs. timely content for sustainable growth
- Be geneours with tiktok and reels content, is the easiest way to get engagement and traffic

CONTENT STRATEGY ELEMENTS TO DEFINE:
1. Content themes and topic clusters
2. Optimal content mix and formats
3. Publishing frequency and timing
4. Target audience segments for each content piece
5. Business objectives each piece should achieve
6. Content distribution channels and promotion strategy
7. Success metrics and KPIs
8. Content dependencies and campaign sequences

OUTPUT FORMAT:
Provide a strategic content plan with the following structure for each content piece:
- Strategic rationale and business goal
- Content topic and angle
- Recommended content type/format
- Target audience segment
- Key messages and themes
- Optimal publishing timing
- Distribution channels
- Success metrics
- Keywords and SEO considerations
- Campaign ID reference (when content is for a specific campaign)

${contentRequirementsContext ? `${contentRequirementsContext}\n\n` : ''}${context}

${additionalContext.length > 0 ? `\nAdditional Parameters:\n${additionalContext.join('\n')}` : ''}`;
        const planningCommand = CommandFactory.createCommand({
            task: 'create strategic content calendar plan',
            userId: userId,
            agentId: agentId,
            agentRole: 'Growth Marketer',
            site_id: siteId,
            description: 'Generate strategic content planning and marketing strategy for content calendar',
            targets: [
                {
                    deep_thinking: "Analyze the business context and create a strategic reasoning for the content planning approach",
                },
                {
                    content_plan: [{
                            strategic_rationale: "Business goal and strategic reasoning for this content piece",
                            content_topic: "Main topic and content angle",
                            content_type: "Recommended content type/format",
                            target_audience: "Primary target audience segment",
                            key_messages: "Core messages and themes to communicate",
                            publishing_timing: "Optimal timing and scheduling recommendations",
                            distribution_channels: "Recommended channels for distribution",
                            success_metrics: "KPIs and metrics to track",
                            seo_keywords: "Primary and secondary keywords for SEO",
                            instructions: "Instructions for the team on how to publish or deliver that content to the target audience",
                            campaign_id: "Campaign ID if content is for a specific campaign (optional)"
                        }]
                }
            ],
            context: growthMarketerPrompt
        });
        const planningCommandId = await commandService.submitCommand(planningCommand);
        console.log(`📈 Growth Marketer planning command created: ${planningCommandId}`);
        const { command: planningResult, completed: planningCompleted } = await waitForCommandCompletion(planningCommandId);
        if (!planningCompleted || !planningResult) {
            console.error('❌ Growth Marketer planning command failed or timed out');
            return null;
        }
        let planningData = [];
        if (planningResult.results && Array.isArray(planningResult.results)) {
            for (const result of planningResult.results) {
                if (result.content_plan && Array.isArray(result.content_plan)) {
                    planningData = result.content_plan;
                    break;
                }
            }
        }
        console.log(`✅ Growth Marketer planning completed with ${planningData.length} strategic recommendations`);
        return planningData;
    }
    catch (error) {
        console.error('❌ Error executing Growth Marketer planning:', error);
        return null;
    }
}
