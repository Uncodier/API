import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID, getCommandService, waitForCommandCompletion } from '@/lib/helpers/command-utils';
import { findTaskManagerAgent, findGrowthMarketerAgent, getPendingCampaigns } from '@/lib/helpers/agent-finder';
import { executeTaskManagerRequirements, createRequirementsFromResults } from './command-helpers-1';
async function handleCommandRequest(request: Request) {
    try {
        let body;
        try {
            body = await request.json();
            console.log('📦 Cuerpo de la solicitud recibido:', JSON.stringify(body, null, 2));
        }
        catch (parseError) {
            console.error('❌ Error al analizar el cuerpo de la solicitud:', parseError);
            return NextResponse.json({ success: false, error: { code: 'INVALID_JSON', message: 'Could not parse request body as JSON' } }, { status: 400 });
        }
        const { siteId, userId, agent_id } = body;
        console.log('🔍 Parámetros extraídos:', { siteId, userId, agent_id });
        if (!siteId) {
            console.log('❌ Error: siteId requerido no proporcionado');
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } }, { status: 400 });
        }
        if (!isValidUUID(siteId)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId must be a valid UUID' } }, { status: 400 });
        }
        let effectiveUserId = userId;
        if (!effectiveUserId) {
            try {
                const { data: siteData, error: siteError } = await supabaseAdmin
                    .from('sites')
                    .select('user_id')
                    .eq('id', siteId)
                    .single();
                if (siteError || !siteData?.user_id) {
                    console.log(`❌ Error: El sitio con ID ${siteId} no existe o no tiene usuario asociado`);
                    return NextResponse.json({ success: false, error: { code: 'SITE_NOT_FOUND', message: `Site not found or has no associated user` } }, { status: 404 });
                }
                effectiveUserId = siteData.user_id;
                console.log(`👤 UserId obtenido del sitio: ${effectiveUserId}`);
            }
            catch (error) {
                console.error('Error al verificar el sitio:', error);
                return NextResponse.json({ success: false, error: { code: 'SITE_VERIFICATION_FAILED', message: 'Failed to verify site existence' } }, { status: 500 });
            }
        }
        const pendingCampaigns = await getPendingCampaigns(siteId);
        if (pendingCampaigns.length === 0) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'NO_PENDING_CAMPAIGNS',
                    message: 'No se encontraron campañas pendientes para generar requisitos'
                }
            }, { status: 404 });
        }
        console.log(`✅ Se encontraron ${pendingCampaigns.length} campañas pendientes`);
        const taskManagerAgent = await findTaskManagerAgent(siteId);
        let selectedAgent = taskManagerAgent;
        if (!taskManagerAgent) {
            console.log(`⚠️ No se encontró Task Manager, buscando Growth Marketer como fallback`);
            const growthMarketerAgent = await findGrowthMarketerAgent(siteId);
            if (!growthMarketerAgent) {
                return NextResponse.json({
                    success: false,
                    error: {
                        code: 'NO_SUITABLE_AGENT_FOUND',
                        message: 'No se encontró un agente adecuado (Task Manager o Growth Marketer) para este sitio'
                    }
                }, { status: 404 });
            }
            selectedAgent = growthMarketerAgent;
            console.log(`📋 Usando Growth Marketer como fallback: ${selectedAgent.agentId}`);
        }
        else {
            console.log(`📋 Task Manager encontrado: ${selectedAgent!.agentId}`);
        }
        if (!effectiveUserId && selectedAgent) {
            effectiveUserId = selectedAgent.userId || 'system';
        }
        if (!selectedAgent) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'NO_AGENT_FOUND',
                    message: 'No se pudo encontrar un agente válido para generar requisitos'
                }
            }, { status: 404 });
        }
        console.log(`📋 INICIANDO: Ejecutando generación de requisitos...`);
        const { requirementsResults, requirementsCommandUuid } = await executeTaskManagerRequirements(siteId, selectedAgent.agentId, effectiveUserId || 'system', pendingCampaigns);
        if (!requirementsResults || requirementsResults.length === 0) {
            console.log(`❌ FALLO: Requirements generation falló - enviando error response`);
            return NextResponse.json({
                success: false,
                error: {
                    code: 'REQUIREMENTS_GENERATION_FAILED',
                    message: 'No se pudo generar los requisitos para las campañas'
                }
            }, { status: 500 });
        }
        console.log(`✅ COMPLETADO: Generación de requisitos completada con ${requirementsResults.length} campañas con requisitos`);
        console.log(`🔑 Requirements Command UUID: ${requirementsCommandUuid}`);
        console.log(`💾 INICIANDO GUARDADO: Guardando requisitos en base de datos...`);
        const { createdRequirements, updatedCampaigns } = await createRequirementsFromResults(requirementsResults, siteId, effectiveUserId, requirementsCommandUuid);
        if (createdRequirements.length === 0) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'NO_REQUIREMENTS_CREATED',
                    message: 'No se pudieron crear requisitos a partir de los resultados del Task Manager'
                }
            }, { status: 400 });
        }
        console.log(`🎉 PROCESO COMPLETO: Enviando respuesta SUCCESS al cliente después de comando + guardado`);
        console.log(`📊 Resumen final: ${createdRequirements.length} requisitos creados para ${updatedCampaigns.length} campañas`);
        return NextResponse.json({
            success: true,
            data: {
                requirements: createdRequirements,
                campaigns: updatedCampaigns
            }
        }, { status: 200 });
    }
    catch (error) {
        console.error('Error al procesar la solicitud:', error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
