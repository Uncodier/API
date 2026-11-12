export const maxDuration = 300;
import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { consolidateSearchMemories, formatSearchMemoryAttribution } from '@/lib/services/analysis/search-memory-data';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { waitForSubmittedCommand } from '@/lib/agentbase/services/command/waitForSubmittedCommand';
import { v4 as uuidv4 } from 'uuid';
import { reportTool } from '@/app/api/agents/tools/report/assistantProtocol';
import { isValidUUID, findDataAnalystAgent, getAgentSearchMemories, commandService } from './command-helpers-1';
async function handleCommandRequest(request: Request) {
    try {
        const body = await request.json();
        const { site_id, agent_id, command_id, data, analysis_type = 'comprehensive', time_range, memory_limit = 50, include_raw_data = false, deliverables } = body;
        if (!site_id) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } }, { status: 400 });
        }
        if (!isValidUUID(site_id)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'site_id must be a valid UUID' } }, { status: 400 });
        }
        let dataAnalystAgent = null;
        if (agent_id && isValidUUID(agent_id)) {
            const { data, error } = await supabaseAdmin
                .from('agents')
                .select('id, user_id')
                .eq('id', agent_id)
                .single();
            if (!error && data) {
                dataAnalystAgent = {
                    agentId: data.id,
                    userId: data.user_id
                };
            }
        }
        if (!dataAnalystAgent) {
            dataAnalystAgent = await findDataAnalystAgent(site_id);
        }
        if (!dataAnalystAgent) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'DATA_ANALYST_NOT_FOUND',
                    message: 'No se encontró un agente con role "Data Analyst" para este sitio'
                }
            }, { status: 404 });
        }
        console.log(`📊 Iniciando análisis para agente: ${dataAnalystAgent.agentId}`);
        let consolidatedData = null;
        let memoriesData = null;
        if (command_id) {
            console.log(`🧠 Obteniendo memorias para command_id: ${command_id}`);
            const memoriesResult = await getAgentSearchMemories(dataAnalystAgent.agentId, time_range, memory_limit, command_id);
            if (!memoriesResult.success || !memoriesResult.memories) {
                return NextResponse.json({
                    success: false,
                    error: {
                        code: 'MEMORIES_FETCH_FAILED',
                        message: memoriesResult.error || 'Failed to fetch agent memories'
                    }
                }, { status: 500 });
            }
            if (memoriesResult.memories.length > 0) {
                memoriesData = memoriesResult.memories;
                consolidatedData = consolidateSearchMemories(memoriesResult.memories);
                console.log(`✅ Memorias obtenidas: ${memoriesResult.memories.length}`);
            }
        }
        if (!consolidatedData && !data) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'NO_DATA_PROVIDED',
                    message: 'No search memories found and no data provided for analysis'
                }
            }, { status: 400 });
        }
        let analysisContext = `Research Data Analysis Request:\n- Analysis type: ${analysis_type}`;
        if (consolidatedData) {
            analysisContext += `
- Total searches analyzed: ${consolidatedData.total_searches}
- Search queries: ${consolidatedData.search_queries.join('; ')}
- Total results found: ${consolidatedData.all_results.length}
- Unique sources: ${consolidatedData.sources.length}
- Search timeframe: ${consolidatedData.search_timeframe.from} to ${consolidatedData.search_timeframe.to}`;
            if (memoriesData && memoriesData.length > 0) {
                analysisContext += `\n\nSearch Memories Data:\n`;
                memoriesData.forEach((memory, index) => {
                    const memoryData = memory.data || {};
                    analysisContext += `\nMemory ${index + 1}:`;
                    if (memoryData.search_query) {
                        analysisContext += `\n- Query: ${memoryData.search_query}`;
                    }
                    analysisContext += formatSearchMemoryAttribution(memoryData);
                    if (memoryData.results && Array.isArray(memoryData.results)) {
                        analysisContext += `\n- Results: ${memoryData.results.length} items`;
                        memoryData.results.slice(0, 3).forEach((result: any, idx: number) => {
                            analysisContext += `\n  ${idx + 1}. ${result.title || 'No title'} - ${result.content?.substring(0, 100) || 'No content'}...`;
                        });
                    }
                });
            }
        }
        if (data) {
            try {
                const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
                const truncatedData = dataStr.length > 10000 ? dataStr.substring(0, 10000) + '... [truncated]' : dataStr;
                analysisContext += `\n\nAdditional Data Provided:\n${truncatedData}`;
            }
            catch (error) {
                analysisContext += `\n\nAdditional Data Provided: [Data structure too complex to serialize]`;
            }
        }
        if (deliverables) {
            try {
                const deliverablesStr = JSON.stringify(deliverables);
                analysisContext += `\n\nDeliverables requested: ${deliverablesStr}`;
            }
            catch (error) {
                analysisContext += `\n\nDeliverables requested: [Complex structure provided]`;
            }
        }
        analysisContext += `\n\nIMPORTANT ANALYSIS INSTRUCTIONS:
1. Please analyze all the available data and provide comprehensive insights and the deliverables requested.
2. CRITICAL: Carefully examine all provided data for inconsistencies, contradictions, or conflicting information.
3. If you identify any data inconsistencies, clearly document them in your analysis and explain how they might impact the reliability of your findings.
4. Cross-reference information from different sources to validate findings and identify potential discrepancies.
5. When inconsistencies are found, provide recommendations on how to resolve them or additional data that might be needed.
6. Ensure all deliverables are based on verified, consistent data to maintain quality and accuracy.`;
        const researchAnalysisStructure = {
            executive_summary: 'string',
            key_findings: 'array',
            data_insights: 'array',
            trend_analysis: 'object',
            recommendations: 'array',
            methodology: 'object',
            limitations: 'array',
            data_inconsistencies: 'array',
            conclusions: 'string',
            deliverables: deliverables ? 'object' : null
        };
        const maxContextLength = 50000;
        const finalContext = analysisContext.length > maxContextLength
            ? analysisContext.substring(0, maxContextLength) + '... [context truncated due to size]'
            : analysisContext.trim();
        const rawTools = [
            reportTool(site_id, dataAnalystAgent.userId ?? ''),
        ];
        const sanitizedTools = rawTools.map(tool => {
            const { handler, execute, ...rest } = tool;
            return rest;
        });
        console.log('🔍 Validando estructura del comando antes de crear...');
        try {
            JSON.stringify({
                context: finalContext,
                targets: [{
                        research_analysis: researchAnalysisStructure
                    }],
                tools: sanitizedTools,
                supervisor: [{
                        agent_role: 'research_manager',
                        status: 'not_initialized'
                    }]
            });
            console.log('✅ Validación de JSON exitosa');
        }
        catch (error) {
            console.error('❌ Error en validación de JSON:', error);
            return NextResponse.json({
                success: false,
                error: {
                    code: 'JSON_SERIALIZATION_ERROR',
                    message: 'Command data structure cannot be serialized to JSON'
                }
            }, { status: 400 });
        }
        const commandData = CommandFactory.createCommand({
            task: 'analyze the research data',
            userId: dataAnalystAgent.userId ?? '',
            description: `Analyze consolidated research data from ${consolidatedData ? consolidatedData.total_searches : 0} searches${data ? ' and additional data' : ''}`,
            agentId: dataAnalystAgent.agentId,
            agentRole: 'Data Analyst',
            site_id: site_id,
            context: finalContext,
            targets: [
                {
                    research_analysis: researchAnalysisStructure
                }
            ],
            tools: sanitizedTools,
            supervisor: [
                {
                    agent_role: 'research_manager',
                    status: 'not_initialized'
                }
            ],
            model: "gpt-5-mini",
            modelType: "openai"
        });
        console.log(`🔧 Creando comando de análisis de investigación`);
        const internalCommandId = await commandService.submitCommand(commandData);
        console.log(`📝 Comando de análisis creado: ${internalCommandId}`);
        const { commandId: commandIdToSearch, command: completedCommand } = await waitForSubmittedCommand(commandService, internalCommandId);
        if (completedCommand && completedCommand.status !== 'completed') {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'COMMAND_EXECUTION_FAILED',
                    message: 'Research analysis command failed to execute',
                    commandId: commandIdToSearch,
                },
            }, { status: 500 });
        }
        if (!completedCommand) {
            console.log('⚠️ Comando no completado después del tiempo máximo de espera');
        }
        const responseData: any = {
            commandId: commandIdToSearch,
            status: completedCommand ? 'completed' : 'timeout',
            message: completedCommand ? 'Research analysis completed' : 'Research analysis timed out - command may still be processing',
            agent_id: dataAnalystAgent.agentId,
            analysis_type: analysis_type,
            filtered_by_command_id: command_id || null,
            has_memories: !!consolidatedData,
            has_additional_data: !!data,
            timestamp: new Date().toISOString()
        };
        if (consolidatedData) {
            responseData.data_summary = {
                total_memories_analyzed: consolidatedData.total_searches,
                unique_search_queries: consolidatedData.search_queries.length,
                total_results_processed: consolidatedData.all_results.length,
                unique_sources: consolidatedData.sources.length,
                search_timeframe: consolidatedData.search_timeframe
            };
            responseData.consolidated_search_data = {
                search_queries: consolidatedData.search_queries,
                sources: consolidatedData.sources,
                answers: consolidatedData.answers,
                answer_attributions: consolidatedData.answer_attributions,
                total_findings: consolidatedData.consolidated_findings.length
            };
        }
        if (data) {
            responseData.additional_data_info = {
                type: typeof data,
                has_content: !!data,
                length: typeof data === 'string' ? data.length : (Array.isArray(data) ? data.length : Object.keys(data || {}).length)
            };
        }
        if (completedCommand && completedCommand.results) {
            try {
                const results = Array.isArray(completedCommand.results) ? completedCommand.results : [completedCommand.results];
                const resultWithResearchAnalysis = results.find((result: any) => result.research_analysis);
                if (resultWithResearchAnalysis) {
                    const researchAnalysisCopy = { ...resultWithResearchAnalysis.research_analysis };
                    if (researchAnalysisCopy.deliverables) {
                        responseData.deliverables = researchAnalysisCopy.deliverables;
                        delete researchAnalysisCopy.deliverables;
                    }
                    responseData.research_analysis = researchAnalysisCopy;
                }
            }
            catch (error) {
                console.error('Error extracting research_analysis from completed command:', error);
            }
        }
        if (include_raw_data) {
            responseData.raw_data = {};
            if (consolidatedData) {
                responseData.raw_data.search_memories = {
                    search_queries: consolidatedData.search_queries,
                    consolidated_findings: consolidatedData.consolidated_findings,
                    sources: consolidatedData.sources,
                    answers: consolidatedData.answers
                };
            }
            if (data) {
                responseData.raw_data.additional_data = data;
            }
        }
        return NextResponse.json({
            success: true,
            data: responseData
        });
    }
    catch (error) {
        console.error('❌ Error en ruta analysis:', error);
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
