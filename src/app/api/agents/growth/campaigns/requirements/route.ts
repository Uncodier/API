import { NextResponse } from 'next/server';
import { CommandFactory } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID, getCommandService, waitForCommandCompletion } from '@/lib/helpers/command-utils';
import { findTaskManagerAgent, findGrowthMarketerAgent, getPendingCampaigns } from '@/lib/helpers/agent-finder';



// Function to execute Task Manager requirements generation
async function executeTaskManagerRequirements(
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

    // Execute requirements command
    const requirementsCommandId = await getCommandService().submitCommand(requirementsCommand);
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

// Función para crear requisitos desde los resultados del Task Manager
async function createRequirementsFromResults(
  campaignsWithRequirements: any[], 
  siteId: string, 
  userId: string, 
  requirementsCommandUuid: string | null
): Promise<{createdRequirements: any[], updatedCampaigns: any[]}> {
  console.log(`🔄 Procesando resultados de Task Manager para crear requisitos...`);
  
  try {
    if (!campaignsWithRequirements || !Array.isArray(campaignsWithRequirements) || campaignsWithRequirements.length === 0) {
      console.log('Los resultados del Task Manager no tienen campañas con requisitos válidas');
      return { createdRequirements: [], updatedCampaigns: [] };
    }
    
    // El command_id para inserción en base de datos
    console.log(`🔑 Requirements Command UUID: ${requirementsCommandUuid}`);
    
    // Verificar que el command_id existe en la tabla commands si es UUID válido
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
      
      // Verificar que la campaña existe
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
      
      // Si la campaña tiene requisitos, guardarlos
      if (campaignWithReqs.requirements && Array.isArray(campaignWithReqs.requirements) && campaignWithReqs.requirements.length > 0) {
        console.log(`📝 Guardando ${campaignWithReqs.requirements.length} requisitos para la campaña ${campaignId}`);
        
        const requirementIds: string[] = [];
        
        for (const reqData of campaignWithReqs.requirements) {
          // Función para extraer valor numérico del budget
          const extractNumericBudget = (budgetValue: any): number => {
            if (typeof budgetValue === 'number') return budgetValue;
            if (!budgetValue) return 0;
            
            // Si es string, extraer números del string (ej: "USD 40" -> 40)
            const budgetStr = budgetValue.toString();
            const match = budgetStr.match(/[\d.]+/);
            return match ? parseFloat(match[0]) : 0;
          };

          // Crear cada requisito
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
            // Usar requirements command para los requisitos
            ...(validRequirementsId ? { command_id: requirementsCommandUuid } : {})
          };
          
          // Insertar el requisito
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
          
          // Guardar el ID para la relación
          requirementIds.push(insertedRequirement.id);
          
          // Crear la relación entre campaña y requisito
          await supabaseAdmin
            .from('campaign_requirements')
            .insert({
              campaign_id: campaignId,
              requirement_id: insertedRequirement.id
            });
        }
        
        // Actualizar el estado de la campaña a 'pending' ya que tiene requisitos
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
        } else {
          console.error('Error al actualizar estado de campaña:', updateError);
          updatedCampaigns.push({
            ...existingCampaign,
            requirement_ids: requirementIds
          });
        }
      } else {
        console.log(`⚠️ No se encontraron requisitos para la campaña ${campaignId}`);
        updatedCampaigns.push({
          ...existingCampaign,
          requirement_ids: []
        });
      }
    }
    
    return { createdRequirements, updatedCampaigns };
  } catch (error) {
    console.error('Error al crear requisitos a partir de resultados del Task Manager:', error);
    return { createdRequirements: [], updatedCampaigns: [] };
  }
}

export async function POST(request: Request) {
  try {
    let body;
    try {
      body = await request.json();
      console.log('📦 Cuerpo de la solicitud recibido:', JSON.stringify(body, null, 2));
    } catch (parseError) {
      console.error('❌ Error al analizar el cuerpo de la solicitud:', parseError);
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_JSON', message: 'Could not parse request body as JSON' } },
        { status: 400 }
      );
    }
    
    // Extraer parámetros directamente como están en la solicitud
    const { siteId, userId, agent_id } = body;
    
    console.log('🔍 Parámetros extraídos:', { siteId, userId, agent_id });
    
    // Validar siteId requerido
    if (!siteId) {
      console.log('❌ Error: siteId requerido no proporcionado');
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    // Make sure siteId is a valid UUID
    if (!isValidUUID(siteId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Si no hay userId, verificar el sitio y buscar el usuario asociado
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
          return NextResponse.json(
            { success: false, error: { code: 'SITE_NOT_FOUND', message: `Site not found or has no associated user` } },
            { status: 404 }
          );
        }
        
        effectiveUserId = siteData.user_id;
        console.log(`👤 UserId obtenido del sitio: ${effectiveUserId}`);
      } catch (error) {
        console.error('Error al verificar el sitio:', error);
        return NextResponse.json(
          { success: false, error: { code: 'SITE_VERIFICATION_FAILED', message: 'Failed to verify site existence' } },
          { status: 500 }
        );
      }
    }
    
    // Get pending campaigns for this site
    const pendingCampaigns = await getPendingCampaigns(siteId);
    
    if (pendingCampaigns.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_PENDING_CAMPAIGNS', 
            message: 'No se encontraron campañas pendientes para generar requisitos' 
          } 
        },
        { status: 404 }
      );
    }
    
    console.log(`✅ Se encontraron ${pendingCampaigns.length} campañas pendientes`);
    
    // Find Task Manager agent for requirements generation
    const taskManagerAgent = await findTaskManagerAgent(siteId);
    
    let selectedAgent = taskManagerAgent;
    
    // If no Task Manager found, use Growth Marketer as fallback
    if (!taskManagerAgent) {
      console.log(`⚠️ No se encontró Task Manager, buscando Growth Marketer como fallback`);
      const growthMarketerAgent = await findGrowthMarketerAgent(siteId);
      
      if (!growthMarketerAgent) {
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'NO_SUITABLE_AGENT_FOUND', 
              message: 'No se encontró un agente adecuado (Task Manager o Growth Marketer) para este sitio' 
            } 
          },
          { status: 404 }
        );
      }
      
      selectedAgent = growthMarketerAgent;
      console.log(`📋 Usando Growth Marketer como fallback: ${selectedAgent.agentId}`);
    } else {
      console.log(`📋 Task Manager encontrado: ${selectedAgent!.agentId}`);
    }
    
    // Set fallback userId if still not defined
    if (!effectiveUserId && selectedAgent) {
      effectiveUserId = selectedAgent.userId || 'system';
    }
    
    // Asegurar que tenemos un agente válido
    if (!selectedAgent) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_AGENT_FOUND', 
            message: 'No se pudo encontrar un agente válido para generar requisitos' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Execute Task Manager requirements generation command
    console.log(`📋 INICIANDO: Ejecutando generación de requisitos...`);
    
    const { requirementsResults, requirementsCommandUuid } = await executeTaskManagerRequirements(
      siteId,
      selectedAgent.agentId,
      effectiveUserId || 'system',
      pendingCampaigns
    );

    if (!requirementsResults || requirementsResults.length === 0) {
      console.log(`❌ FALLO: Requirements generation falló - enviando error response`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'REQUIREMENTS_GENERATION_FAILED', 
            message: 'No se pudo generar los requisitos para las campañas' 
          } 
        },
        { status: 500 }
      );
    }

    console.log(`✅ COMPLETADO: Generación de requisitos completada con ${requirementsResults.length} campañas con requisitos`);
    console.log(`🔑 Requirements Command UUID: ${requirementsCommandUuid}`);
    console.log(`💾 INICIANDO GUARDADO: Guardando requisitos en base de datos...`);

    // Create requirements from Task Manager results
    const { createdRequirements, updatedCampaigns } = await createRequirementsFromResults(
      requirementsResults, 
      siteId, 
      effectiveUserId, 
      requirementsCommandUuid
    );
    
    if (createdRequirements.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_REQUIREMENTS_CREATED', 
            message: 'No se pudieron crear requisitos a partir de los resultados del Task Manager' 
          } 
        },
        { status: 400 }
      );
    }
    
    console.log(`🎉 PROCESO COMPLETO: Enviando respuesta SUCCESS al cliente después de comando + guardado`);
    console.log(`📊 Resumen final: ${createdRequirements.length} requisitos creados para ${updatedCampaigns.length} campañas`);
    
    // Devolver respuesta exitosa con los requisitos creados
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          requirements: createdRequirements,
          campaigns: updatedCampaigns
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } },
      { status: 500 }
    );
  }
} 