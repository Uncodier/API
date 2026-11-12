import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID, findCopywriterAgent, getAgentInfo, getDraftContentForSite, updateMultipleContentInDatabase, commandService, getCommandDbUuid, waitForCommandCompletion } from './command-helpers-1';
import { buildContext } from './command-helpers-2';
async function handleCommandRequest(request: Request) {
    try {
        const body = await request.json();
        const { siteId, contentIds, segmentId, campaignId, userId, agent_id, improvementGoals, targetAudience, keywords, contentStyle, maxLength, limit } = body;
        if (!siteId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } }, { status: 400 });
        }
        if (!isValidUUID(siteId)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId must be a valid UUID' } }, { status: 400 });
        }
        if (contentIds && (!Array.isArray(contentIds) || contentIds.some(id => !isValidUUID(id)))) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'contentIds must be an array of valid UUIDs' } }, { status: 400 });
        }
        let effectiveUserId = userId;
        let effectiveAgentId = agent_id;
        if (!effectiveAgentId) {
            const foundAgent = await findCopywriterAgent(siteId);
            if (foundAgent) {
                effectiveAgentId = foundAgent.agentId;
                if (!effectiveUserId) {
                    effectiveUserId = foundAgent.userId;
                }
                console.log(`🤖 Usando agente con rol "copywriter" encontrado: ${effectiveAgentId} (user_id: ${effectiveUserId})`);
            }
            else {
                effectiveAgentId = 'default_copywriter_agent';
                console.log(`🤖 No se encontró agente específico, usando agente por defecto: ${effectiveAgentId}`);
            }
        }
        if (effectiveAgentId && !effectiveUserId) {
            const agentInfo = await getAgentInfo(effectiveAgentId);
            if (!agentInfo) {
                return NextResponse.json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } }, { status: 404 });
            }
            effectiveUserId = agentInfo.user_id;
        }
        if (!effectiveUserId) {
            effectiveUserId = 'system';
        }
        const effectiveLimit = limit || 50;
        console.log(`Creating bulk content improvement command for agent: ${effectiveAgentId}, user: ${effectiveUserId}, site: ${siteId}`);
        const draftContent = await getDraftContentForSite(siteId, segmentId, campaignId, contentIds, effectiveLimit);
        if (draftContent.length === 0) {
            return NextResponse.json({ success: false, error: { code: 'NO_DRAFT_CONTENT', message: 'No draft content found for improvement' } }, { status: 404 });
        }
        console.log(`Found ${draftContent.length} draft content items to improve`);
        const context = await buildContext(siteId, draftContent, segmentId, campaignId);
        let additionalContext = [];
        if (improvementGoals && Array.isArray(improvementGoals) && improvementGoals.length > 0) {
            additionalContext.push(`IMPROVEMENT GOALS:`);
            improvementGoals.forEach((goal, index) => {
                additionalContext.push(`  ${index + 1}. ${goal}`);
            });
        }
        if (targetAudience) {
            const formattedAudience = Array.isArray(targetAudience)
                ? targetAudience.join(', ')
                : targetAudience;
            additionalContext.push(`TARGET AUDIENCE FOCUS: ${formattedAudience}`);
        }
        if (keywords && Array.isArray(keywords) && keywords.length > 0) {
            additionalContext.push(`KEYWORDS TO OPTIMIZE:`);
            const groupedKeywords = [];
            for (let i = 0; i < keywords.length; i += 5) {
                const group = keywords.slice(i, i + 5).join(', ');
                groupedKeywords.push(`  • ${group}`);
            }
            additionalContext.push(groupedKeywords.join('\n'));
        }
        if (contentStyle) {
            additionalContext.push(`CONTENT STYLE: ${contentStyle}`);
        }
        if (maxLength) {
            additionalContext.push(`MAXIMUM LENGTH PER CONTENT: ${maxLength} characters`);
        }
        const fullContext = additionalContext.length > 0
            ? `Perform BULK IMPROVEMENT of all draft content for maximum business impact and consistency.

BULK IMPROVEMENT OBJECTIVES:
- Improve ALL content items simultaneously while maintaining consistency
- Enhance content quality, readability, and engagement across all pieces
- Optimize for SEO and target keywords while maintaining natural flow
- Align all content with brand voice and target audience preferences
- Improve structure, clarity, and call-to-action effectiveness
- Ensure all content meets current marketing goals and campaign objectives
- Maintain each content's original purpose while maximizing impact

BULK IMPROVEMENT GUIDELINES:
1. Content Analysis (for all items):
   - Assess current content strengths and weaknesses
   - Identify opportunities for SEO optimization
   - Evaluate alignment with target audience and brand voice
   - Check for clarity, flow, and engagement factors

2. Content Enhancement (for each item):
   - Improve headlines and subheadings for better impact
   - Enhance introductions and conclusions for stronger engagement
   - Optimize content structure and readability
   - Incorporate target keywords naturally
   - Strengthen call-to-action elements
   - Add relevant examples, statistics, or case studies if appropriate

3. Consistency Assurance:
   - Maintain consistent brand voice across all content
   - Ensure cohesive messaging and style
   - Apply uniform quality standards
   - Coordinate keyword usage across pieces

4. Deliverables (for each content item):
   - Provide the improved content with clear formatting
   - Include content ID for database updates
   - Include a summary of key improvements made
   - List specific optimizations applied (SEO, readability, engagement)
   - Provide content quality score (before and after if possible)
   - Note any recommendations for further optimization

${context}\n\nImprovement Parameters:\n${additionalContext.join('\n')}`
            : `Perform BULK IMPROVEMENT of all draft content for maximum business impact and consistency.

BULK IMPROVEMENT OBJECTIVES:
- Improve ALL content items simultaneously while maintaining consistency
- Enhance content quality, readability, and engagement across all pieces
- Optimize for SEO and target keywords while maintaining natural flow
- Align all content with brand voice and target audience preferences
- Improve structure, clarity, and call-to-action effectiveness
- Ensure all content meets current marketing goals and campaign objectives
- Maintain each content's original purpose while maximizing impact

BULK IMPROVEMENT GUIDELINES:
1. Content Analysis (for all items):
   - Assess current content strengths and weaknesses
   - Identify opportunities for SEO optimization
   - Evaluate alignment with target audience and brand voice
   - Check for clarity, flow, and engagement factors

2. Content Enhancement (for each item):
   - Improve headlines and subheadings for better impact
   - Enhance introductions and conclusions for stronger engagement
   - Optimize content structure and readability
   - Incorporate target keywords naturally
   - Strengthen call-to-action elements
   - Add relevant examples, statistics, or case studies if appropriate

3. Consistency Assurance:
   - Maintain consistent brand voice across all content
   - Ensure cohesive messaging and style
   - Apply uniform quality standards
   - Coordinate keyword usage across pieces

4. Deliverables (for each content item):
   - Provide the improved content with clear formatting
   - Include content ID for database updates
   - Include a summary of key improvements made
   - List specific optimizations applied (SEO, readability, engagement)
   - Provide content quality score (before and after if possible)
   - Note any recommendations for further optimization

${context}`;
        const command = CommandFactory.createCommand({
            task: 'bulk improve content',
            userId: effectiveUserId,
            agentId: effectiveAgentId,
            agentRole: 'Content Creator & Copywriter',
            site_id: siteId,
            description: `Bulk improve and optimize ${draftContent.length} draft content items for site ${siteId} to enhance effectiveness, readability, and business impact while maintaining brand voice and optimizing for target keywords.`,
            targets: [
                {
                    deep_thinking: "Write a deep thinking reasoning about the content to be improved"
                },
                ...draftContent.map(content => ({
                    content_id: content.id,
                    action: 'update',
                    content: [{
                            improvements_applied: ["List of specific improvements made"],
                            text: "Improved markdown content with enhanced readability, SEO optimization, and engagement factors",
                            title: "Enhanced and optimized title",
                            description: "Improved and compelling description",
                            original_score: "Content quality score before improvement",
                            improvement_notes: "Summary of key improvements and optimizations applied",
                            improved_score: "Content quality score after improvement"
                        }]
                }))
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
        const internalCommandId = await commandService.submitCommand(command);
        console.log(`📝 Bulk content improvement command created with internal ID: ${internalCommandId}`);
        let initialDbUuid = await getCommandDbUuid(internalCommandId);
        if (initialDbUuid) {
            console.log(`📌 Database UUID obtained initially: ${initialDbUuid}`);
        }
        const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
        const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
        if (!completed || !executedCommand) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'COMMAND_EXECUTION_FAILED',
                    message: 'The bulk content improvement command did not complete successfully in the expected time'
                }
            }, { status: 500 });
        }
        let improvedContentItems: any[] = [];
        if (executedCommand.results && Array.isArray(executedCommand.results)) {
            const contentResult = executedCommand.results.find((r: any) => r.type === 'content' ||
                (r.content && Array.isArray(r.content.content)) ||
                (Array.isArray(r.content)));
            if (contentResult) {
                if (contentResult.content && Array.isArray(contentResult.content.content)) {
                    improvedContentItems = contentResult.content.content;
                }
                else if (Array.isArray(contentResult.content)) {
                    improvedContentItems = contentResult.content;
                }
            }
        }
        if (improvedContentItems.length === 0) {
            console.error('No improved content found in command results');
            return NextResponse.json({
                success: false,
                error: {
                    code: 'NO_IMPROVED_CONTENT',
                    message: 'No improved content was generated by the agent'
                }
            }, { status: 500 });
        }
        console.log(`📊 Generated ${improvedContentItems.length} improved content items`);
        if (improvedContentItems.length !== draftContent.length) {
            console.error(`❌ Mismatch: ${draftContent.length} original content items but ${improvedContentItems.length} improved items`);
            return NextResponse.json({
                success: false,
                error: {
                    code: 'CONTENT_MISMATCH',
                    message: `Expected ${draftContent.length} improved content items but got ${improvedContentItems.length}`
                }
            }, { status: 500 });
        }
        const mappedResults = draftContent.map((originalContent, index) => {
            const improvedItem = improvedContentItems[index];
            if (!improvedItem) {
                console.error(`❌ No improved content found for index ${index}, contentId: ${originalContent.id}`);
                return null;
            }
            console.log(`🔄 Mapping original content ${originalContent.id} (index ${index}) -> improved content`);
            return {
                contentId: originalContent.id,
                improvedContent: improvedItem,
                originalContent
            };
        });
        const improvementResults = mappedResults.filter((result): result is {
            contentId: string;
            improvedContent: any;
            originalContent: any;
        } => result !== null);
        if (improvementResults.length === 0) {
            console.error('❌ No valid improvement results to process');
            return NextResponse.json({
                success: false,
                error: {
                    code: 'NO_VALID_IMPROVEMENTS',
                    message: 'No valid improvement results could be generated'
                }
            }, { status: 500 });
        }
        const { updated, failed } = await updateMultipleContentInDatabase(improvementResults, effectiveUserId);
        if (updated.length === 0) {
            console.error('Failed to update any content in database');
            return NextResponse.json({
                success: false,
                error: {
                    code: 'DATABASE_UPDATE_FAILED',
                    message: 'Failed to update any improved content in the database'
                }
            }, { status: 500 });
        }
        return NextResponse.json({
            success: true,
            data: {
                command_id: effectiveDbUuid || internalCommandId,
                siteId,
                segmentId,
                campaignId,
                processed_count: draftContent.length,
                updated_count: updated.length,
                failed_count: failed.length,
                failed_content_ids: failed,
                original_content: draftContent.map(content => ({
                    id: content.id,
                    title: content.title,
                    description: content.description,
                    status: content.status
                })),
                improved_content: updated,
                improvements_summary: `Successfully improved ${updated.length} out of ${draftContent.length} content items`
            }
        }, { status: 200 });
    }
    catch (error) {
        console.error('Error processing bulk content improvement request:', error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the bulk content improvement request' } }, { status: 500 });
    }
}
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');
        const segmentId = searchParams.get('segmentId');
        const campaignId = searchParams.get('campaignId');
        const limit = parseInt(searchParams.get('limit') || '50');
        if (!siteId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } }, { status: 400 });
        }
        if (!isValidUUID(siteId)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId must be a valid UUID' } }, { status: 400 });
        }
        console.log(`Fetching draft content for site: ${siteId}`);
        const draftContent = await getDraftContentForSite(siteId, segmentId || undefined, campaignId || undefined, undefined, limit);
        return NextResponse.json({
            success: true,
            data: {
                siteId,
                segmentId,
                campaignId,
                draft_content: draftContent,
                total_items: draftContent.length
            }
        }, { status: 200 });
    }
    catch (error) {
        console.error('Error fetching draft content:', error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while fetching draft content' } }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
