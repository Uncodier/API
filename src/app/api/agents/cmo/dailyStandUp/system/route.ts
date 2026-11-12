import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { isValidUUID, saveToAgentMemory, findActiveCmoAgent, getSystemData, waitForCommandCompletion, commandService } from './command-helpers-1';
async function handleCommandRequest(request: Request) {
    try {
        const body = await request.json();
        const { site_id, command_id } = body;
        if (!site_id || !isValidUUID(site_id)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required and must be a valid UUID' } }, { status: 400 });
        }
        const agent = await findActiveCmoAgent(site_id);
        if (!agent) {
            return NextResponse.json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: 'No active CMO agent found for this site' } }, { status: 404 });
        }
        console.log(`🤖 Iniciando daily standup system para agente: ${agent.agentId}, usuario: ${agent.userId}, sitio: ${site_id}`);
        const systemData = await getSystemData(site_id);
        if (!systemData) {
            return NextResponse.json({ success: false, error: { code: 'DATA_ERROR', message: 'Could not retrieve system data' } }, { status: 500 });
        }
        const contextMessage = `Daily StandUp - System Analysis for Site: ${site_id}

TASK: Conduct a comprehensive human analysis of our system health and provide strategic recommendations for optimization and growth.

As our CMO, please analyze the current system state and provide your expert assessment:

Available Data Sources:
- Site configuration and current settings
- Billing and subscription information  
- Recent system activity and user engagement
- Configuration completeness across all channels

REQUIRED ANALYSIS & RECOMMENDATIONS:

1. SYSTEM HEALTH ASSESSMENT
   - What's your overall assessment of our system health? (Green/Yellow/Red and why)
   - What are the most critical issues you've identified?
   - How would you rate our current operational stability?

2. STRATEGIC BILLING REVIEW
   - How healthy is our subscription and billing status?
   - Are there any financial concerns or optimization opportunities?
   - What billing-related actions should we prioritize?

3. CONFIGURATION & SETUP ANALYSIS
   - How complete is our system configuration from a business perspective?
   - What critical gaps are preventing us from maximizing performance?
   - Which configuration improvements would drive the most impact?

4. ONBOARDING & ACTIVATION STATUS
   - What percentage of our setup do you estimate is complete?
   - What are the biggest blockers preventing full system activation?
   - What would you prioritize to improve user onboarding experience?

5. STRATEGIC ACTION RECOMMENDATIONS
   - What are your top 3 strategic priorities for this week?
   - Which quick wins could we implement immediately?
   - What configuration changes would you recommend to drive growth?

6. RISK & OPPORTUNITY ASSESSMENT
   - What risks do you see in our current system state?
   - What opportunities are we missing due to incomplete setup?
   - What preventive measures should we implement?

Please provide your analysis in a conversational, strategic format as if you're briefing the executive team. Focus on business impact, user experience, and growth opportunities rather than technical details.

CRITICAL FORMAT RULES (MUST FOLLOW):
- Output must be plain text only. Do not use markdown, HTML, emojis, or code fences.
- Use ASCII characters only. Avoid smart quotes and special symbols.
- Use simple dashes '-' for bullet points when needed.
- Provide a single line beginning with 'Status:' followed by one of GREEN, YELLOW, or RED and a short reason (e.g., "Status: GREEN - billing active and configuration progressing").
- Provide short bullets for priorities starting with '- '. Keep lines under 140 characters.
- Avoid headings with markdown markers (#, **, etc.). Use simple plain sentences.

IMPORTANT:
- The summary should be in the language of the company.

Raw System Data:
${JSON.stringify({
            siteConfig: systemData.siteConfig,
            settingsData: systemData.siteSettings,
            billingInfo: systemData.billingData,
            activityMetrics: {
                recentEvents: systemData.metricsCount,
                settingsCount: systemData.settingsCount
            }
        }, null, 2)}`;
        const command = CommandFactory.createCommand({
            task: 'daily standup system analysis',
            userId: agent.userId,
            agentId: agent.agentId,
            agentRole: 'Growth Lead/Manager',
            site_id: site_id,
            description: 'Analyze system settings, billing status, and basic system metrics for daily standup report',
            targets: [
                {
                    strategic_system_analysis: {
                        analysis_type: "cmo_daily_standup_strategic_review",
                        business_assessment: "comprehensive system health and_optimization_analysis",
                        focus_areas: [
                            "list with activities to do in order to finish the account setup"
                        ],
                        output_format: "plain_text_executive_briefing",
                        perspective: "cmo_strategic_business_analysis"
                    }
                }
            ],
            tools: [],
            context: contextMessage,
            supervisor: [
                {
                    agent_role: "system_administrator",
                    status: "not_initialized"
                }
            ]
        });
        const internalCommandId = await commandService.submitCommand(command);
        console.log(`📝 Comando system analysis creado con ID: ${internalCommandId}`);
        let initialDbUuid: string | null = null;
        try {
            const tempCommand = await commandService.getCommandById(internalCommandId);
            if (tempCommand?.metadata?.dbUuid && isValidUUID(tempCommand.metadata.dbUuid)) {
                initialDbUuid = tempCommand.metadata.dbUuid;
                console.log(`🔑 UUID inicial obtenido: ${initialDbUuid}`);
            }
        }
        catch (err) {
            console.log('No se pudo obtener UUID inicial');
        }
        const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(commandService, internalCommandId);
        if (!completed || !executedCommand) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'COMMAND_EXECUTION_FAILED',
                    message: 'The system analysis command did not complete successfully'
                }
            }, { status: 500 });
        }
        const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
        let strategicAnalysis = null;
        if (executedCommand.results && Array.isArray(executedCommand.results)) {
            const analysisResults = executedCommand.results.find((r: any) => r.strategic_system_analysis);
            if (analysisResults && analysisResults.strategic_system_analysis) {
                strategicAnalysis = analysisResults.strategic_system_analysis;
                console.log(`📊 Strategic analysis extraído exitosamente`);
            }
        }
        if (!strategicAnalysis) {
            console.error('❌ No se pudo extraer el análisis estratégico de los resultados');
            return NextResponse.json({
                success: false,
                error: {
                    code: 'ANALYSIS_EXTRACTION_FAILED',
                    message: 'Could not extract strategic analysis from command results'
                }
            }, { status: 500 });
        }
        console.log(`📊 Strategic analysis completado para comando: ${effectiveDbUuid || internalCommandId}`);
        const memoryResult = await saveToAgentMemory(agent.agentId, agent.userId, effectiveDbUuid || internalCommandId, strategicAnalysis, site_id);
        if (!memoryResult.success) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'MEMORY_SAVE_FAILED',
                    message: memoryResult.error
                }
            }, { status: 500 });
        }
        return NextResponse.json({
            success: true,
            data: {
                command_id: effectiveDbUuid || internalCommandId,
                strategic_analysis: strategicAnalysis,
                analysis_type: "system",
                system_data: {
                    site_status: systemData.siteConfig?.status,
                    billing_status: systemData.billingData?.status,
                    events_count: systemData.metricsCount,
                    settings_count: systemData.settingsCount
                }
            }
        }, { status: 200 });
    }
    catch (error) {
        console.error('Error en daily standup system analysis:', error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the system analysis' } }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
