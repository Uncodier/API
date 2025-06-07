import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Función para obtener el UUID de la base de datos para un comando
async function getCommandDbUuid(internalId: string): Promise<string | null> {
  try {
    // Intentar obtener el comando
    const command = await commandService.getCommandById(internalId);
    
    // Verificar metadata
    if (command && command.metadata && command.metadata.dbUuid) {
      if (isValidUUID(command.metadata.dbUuid)) {
        console.log(`🔑 UUID encontrado en metadata: ${command.metadata.dbUuid}`);
        return command.metadata.dbUuid;
      }
    }
    
    // Buscar en el mapa de traducción interno del CommandService
    try {
      // @ts-ignore - Accediendo a propiedades internas
      const idMap = (commandService as any).idTranslationMap;
      if (idMap && idMap.get && idMap.get(internalId)) {
        const mappedId = idMap.get(internalId);
        if (isValidUUID(mappedId)) {
          console.log(`🔑 UUID encontrado en mapa interno: ${mappedId}`);
          return mappedId;
        }
      }
    } catch (err) {
      console.log('No se pudo acceder al mapa de traducción interno');
    }
    
    // Buscar en la base de datos directamente por algún campo que pueda relacionarse
    if (command) {
      const { data, error } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('task', command.task)
        .eq('user_id', command.user_id)
        .eq('status', command.status)
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && data && data.length > 0) {
        console.log(`🔑 UUID encontrado en búsqueda directa: ${data[0].id}`);
        return data[0].id;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error al obtener UUID de base de datos:', error);
    return null;
  }
}

// Función para esperar a que un comando se complete
async function waitForCommandCompletion(commandId: string, maxAttempts = 60, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  let dbUuid: string | null = null;
  
  console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
  
  // Crear una promesa que se resuelve cuando el comando se completa o se agota el tiempo
  return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        executedCommand = await commandService.getCommandById(commandId);
        
        if (!executedCommand) {
          console.log(`⚠️ No se pudo encontrar el comando ${commandId}`);
          clearInterval(checkInterval);
          resolve({command: null, dbUuid: null, completed: false});
          return;
        }
        
        // Guardar el UUID de la base de datos si está disponible
        if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
          dbUuid = executedCommand.metadata.dbUuid as string;
          console.log(`🔑 UUID de base de datos encontrado en metadata: ${dbUuid}`);
        }
        
        // Verificar si el comando falló explícitamente
        if (executedCommand.status === 'failed') {
          console.log(`❌ El comando ${commandId} falló con estado: failed`);
          console.log(`❌ Error: ${executedCommand.error || 'No hay detalles del error'}`);
          
          // Intentar obtener el UUID de la base de datos si aún no lo tenemos
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido después de fallo: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: false});
          return;
        }
        
        // Comprobar si el comando se ha completado basado en su estado
        const isStatusCompleted = executedCommand.status === 'completed';
        
        // Comprobar también si hay resultados, aunque el estado no sea 'completed'
        const hasResults = executedCommand.results && 
                          Array.isArray(executedCommand.results) && 
                          executedCommand.results.length > 0;
        
        // Si el estado es completed o hay resultados disponibles, considerar el comando como completado
        if (isStatusCompleted || hasResults) {
          // Si tiene resultados pero el estado no es completed, hacerlo notar
          if (hasResults && !isStatusCompleted) {
            console.log(`⚠️ El comando ${commandId} tiene resultados pero su estado es ${executedCommand.status}. Asumiéndolo como completado.`);
          } else {
            console.log(`✅ Comando ${commandId} completado con estado: ${executedCommand.status}`);
          }
          
          // Intentar obtener el UUID de la base de datos si aún no lo tenemos
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: true});
          return;
        }
        
        console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
          
          // Como último recurso, verificar una vez más si el comando tiene resultados
          // aunque no se haya actualizado su estado
          if (hasResults) {
            console.log(`🔍 El comando ${commandId} tiene resultados a pesar de timeout. Procesándolo como completado.`);
            clearInterval(checkInterval);
            resolve({command: executedCommand, dbUuid, completed: true});
            return;
          }
          
          // Último intento de obtener el UUID
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido antes de timeout: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: false});
        }
      } catch (error) {
        console.error(`Error al verificar estado del comando ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, dbUuid: null, completed: false});
      }
    }, delayMs);
  });
}

// Función para crear campañas y requisitos desde los resultados del comando
async function createCampaignsFromResults(command: any, siteId: string, userId: string, dbUuid: string | null): Promise<any[]> {
  console.log(`🔄 Procesando resultados para crear campañas...`);
  
  try {
    if (!command || !command.results || !Array.isArray(command.results) || command.results.length === 0) {
      console.log('El comando no tiene resultados válidos');
      return [];
    }
    
    // Buscar las campañas en diferentes estructuras posibles de resultados
    let campaignsToCreate: any[] = [];
    
    // Buscar directamente un resultado con campañas
    const campaignsResult = command.results.find((r: any) => r && r.campaigns && Array.isArray(r.campaigns));
    if (campaignsResult && campaignsResult.campaigns) {
      campaignsToCreate = campaignsResult.campaigns;
      console.log(`✅ Se encontraron ${campaignsToCreate.length} campañas en los resultados directos`);
    } 
    // Buscar en la estructura content.campaigns
    else {
      for (const result of command.results) {
        if (result && result.content && result.content.campaigns && Array.isArray(result.content.campaigns)) {
          campaignsToCreate = result.content.campaigns;
          console.log(`✅ Se encontraron ${campaignsToCreate.length} campañas en result.content.campaigns`);
          break;
        }
      }
    }
    
    // Si no encontramos campañas en resultados, intentar con los targets
    if (campaignsToCreate.length === 0 && command.targets && Array.isArray(command.targets)) {
      // Buscar campaña en targets
      const campaignsTarget = command.targets.find((t: any) => t && t.campaigns && Array.isArray(t.campaigns));
      if (campaignsTarget && campaignsTarget.campaigns) {
        campaignsToCreate = campaignsTarget.campaigns;
        console.log(`✅ Se encontraron ${campaignsToCreate.length} campañas en los targets`);
      }
    }
    
    if (campaignsToCreate.length === 0) {
      console.log('No se encontraron campañas en los resultados o targets del comando');
      return [];
    }
    
    // Efectivo command_id para inserción en base de datos
    const effectiveCommandId = dbUuid || command.id;
    console.log(`🔑 Usando command_id para base de datos: ${effectiveCommandId}`);
    
    // Verificar que el command_id existe en la tabla commands
    if (isValidUUID(effectiveCommandId)) {
      const { data: commandExists, error: commandCheckError } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('id', effectiveCommandId)
        .single();
      
      if (commandCheckError || !commandExists) {
        console.log(`⚠️ El command_id ${effectiveCommandId} no existe en la tabla 'commands'`);
        console.log(`🔄 Se procederá a crear las campañas sin vinculación a comando`);
      }
    }
    
    console.log(`📝 Creando ${campaignsToCreate.length} campañas a partir de los resultados del comando`);
    
    // Sanitizar los datos de las campañas
    campaignsToCreate = campaignsToCreate.map(campaign => {
      // Sanitizar presupuesto
      if (typeof campaign.budget === 'string' || !campaign.budget) {
        campaign.budget = {
          currency: "USD",
          allocated: 1000,
          remaining: 1000
        };
      } else if (typeof campaign.budget === 'object') {
        campaign.budget = {
          currency: "USD",
          allocated: typeof campaign.budget.allocated === 'number' ? campaign.budget.allocated : 1000,
          remaining: typeof campaign.budget.remaining === 'number' ? campaign.budget.remaining : 1000
        };
      }
      
      // Sanitizar revenue
      if (typeof campaign.revenue === 'string' || !campaign.revenue) {
        campaign.revenue = {
          actual: 0,
          currency: "USD",
          estimated: 3000,
          projected: 5000
        };
      } else if (typeof campaign.revenue === 'object') {
        campaign.revenue = {
          actual: typeof campaign.revenue.actual === 'number' ? campaign.revenue.actual : 0,
          currency: "USD",
          estimated: typeof campaign.revenue.estimated === 'number' ? campaign.revenue.estimated : 3000,
          projected: typeof campaign.revenue.projected === 'number' ? campaign.revenue.projected : 5000
        };
      }
      
      // Sanitizar due_date
      if (!campaign.due_date || typeof campaign.due_date === 'string' && 
          (campaign.due_date.includes('example') || campaign.due_date.includes('YYYY-MM-DD'))) {
        campaign.due_date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      }
      
      // Sanitizar type
      if (!campaign.type || typeof campaign.type === 'string' && 
          (campaign.type.includes("'") || campaign.type.includes('|'))) {
        const validTypes = ['inbound', 'outbound', 'branding', 'product', 'events', 'success', 
                           'account', 'community', 'guerrilla', 'affiliate', 'experiential', 
                           'programmatic', 'performance', 'publicRelations'];
        campaign.type = validTypes[Math.floor(Math.random() * validTypes.length)];
      }
      
      return campaign;
    });
    
    // Crear las campañas en la base de datos
    const createdCampaigns: any[] = [];
    
    for (const campaignData of campaignsToCreate) {
      // Preparar los datos básicos de la campaña
      const campaignToInsert = {
        title: campaignData.title || 'Campaña sin título',
        description: campaignData.description || '',
        status: campaignData.status || 'pending',
        type: campaignData.type || 'general',
        priority: campaignData.priority || 'medium',
        budget: campaignData.budget || { 
          currency: "USD", 
          allocated: 4000, 
          remaining: 3600 
        },
        revenue: campaignData.revenue || { 
          actual: 0, 
          currency: "USD", 
          estimated: 12000, 
          projected: 15000 
        },
        due_date: campaignData.due_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        site_id: siteId,
        user_id: userId,
        // Solo incluir command_id si es un UUID válido y existe en la tabla
        ...(isValidUUID(effectiveCommandId) ? { command_id: effectiveCommandId } : {})
      };
      
      // Insertar la campaña
      const { data: insertedCampaign, error: insertError } = await supabaseAdmin
        .from('campaigns')
        .insert([campaignToInsert])
        .select('*')
        .single();
      
      if (insertError) {
        console.error('Error al crear campaña:', insertError);
        continue;
      }
      
      console.log(`✅ Campaña creada con ID: ${insertedCampaign.id}`);
      
      // Si la campaña tiene requisitos, guardarlos
      if (campaignData.requirements && Array.isArray(campaignData.requirements) && campaignData.requirements.length > 0) {
        console.log(`📝 Guardando ${campaignData.requirements.length} requisitos para la campaña ${insertedCampaign.id}`);
        
        const requirementIds: string[] = [];
        
        for (const reqData of campaignData.requirements) {
          // Crear cada requisito
          const requirementToInsert = {
            title: reqData.title || 'Requisito sin título',
            description: reqData.description || '',
            instructions: reqData.instructions || '',
            budget: reqData.budget || '0',
            priority: reqData.priority || 'medium',
            site_id: siteId,
            status: 'backlog',
            completion_status: 'pending',
            user_id: userId,
            // Solo incluir command_id si es un UUID válido
            ...(isValidUUID(effectiveCommandId) ? { command_id: effectiveCommandId } : {})
          };
          
          // Insertar el requisito
          const { data: insertedRequirement, error: reqInsertError } = await supabaseAdmin
            .from('requirements')
            .insert([requirementToInsert])
            .select('id')
            .single();
          
          if (reqInsertError) {
            console.error('Error al crear requisito:', reqInsertError);
            continue;
          }
          
          // Guardar el ID para la relación
          requirementIds.push(insertedRequirement.id);
          
          // Crear la relación entre campaña y requisito
          await supabaseAdmin
            .from('campaign_requirements')
            .insert({
              campaign_id: insertedCampaign.id,
              requirement_id: insertedRequirement.id
            });
        }
        
        // Añadir los requisitos al objeto de campaña que se devuelve
        createdCampaigns.push({
          ...insertedCampaign,
          requirement_ids: requirementIds
        });
      } else {
        createdCampaigns.push({
          ...insertedCampaign,
          requirement_ids: []
        });
      }
    }
    
    return createdCampaigns;
  } catch (error) {
    console.error('Error al crear campañas a partir de resultados:', error);
    return [];
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
    
    // Validar agent_id requerido, o buscar agente Growth Marketer por defecto
    let effectiveAgentId = agent_id;
    if (!effectiveAgentId) {
      console.log('🔍 No se proporcionó agent_id, buscando agente con rol "Growth Marketer"...');
      try {
        const { data: growthAgent, error: agentError } = await supabaseAdmin
          .from('agents')
          .select('id')
          .eq('role', 'Growth Marketer')
          .limit(1)
          .single();
        
        if (agentError || !growthAgent) {
          console.log('❌ Error: No se encontró agente con rol "Growth Marketer"');
          return NextResponse.json(
            { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'No agent_id provided and no Growth Marketer agent found' } },
            { status: 400 }
          );
        }
        
        effectiveAgentId = growthAgent.id;
        console.log(`✅ Agente Growth Marketer encontrado: ${effectiveAgentId}`);
      } catch (error) {
        console.error('Error al buscar agente Growth Marketer:', error);
        return NextResponse.json(
          { success: false, error: { code: 'AGENT_SEARCH_FAILED', message: 'Failed to search for Growth Marketer agent' } },
          { status: 500 }
        );
      }
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
    
    console.log(`📨 Solicitud validada. SiteId: ${siteId}, UserId: ${effectiveUserId}, AgentId: ${effectiveAgentId}`);
    
    // Crear contexto simple para el comando
    const promptInstructions = `
INSTRUCTIONS:
1. Create detailed and actionable marketing campaigns with clear objectives.
2. Each campaign should include:
   - A descriptive title that reflects the campaign's purpose
   - A comprehensive description explaining the strategy and goals
   - Appropriate type (inbound, outbound, branding, etc.)
   - Realistic priority level based on business impact
   - Reasonable budget and revenue projections
   - Realistic due date for completion
3. For each campaign, develop specific requirements that:
   - Break down the campaign into concrete, implementable tasks
   - Include clear instructions for execution
   - Specify priority levels and budget allocations for each requirement
   - Provide enough detail for team members to understand and implement
4. The total budget for all campaigns shoud not exceed the available budget for the site.
5. When there is no more avalaible budget, focus in 0 cost campaigns, content, or any other type of campaign that does not require an investment.

Your campaigns should be strategic, measurable, and aligned with business growth objectives.`;

    const context = `Generate marketing campaign ideas for Site ID: ${siteId}\n\n${promptInstructions}`;
    
    console.log(`🧠 Creando comando con agentId: ${effectiveAgentId}`);
    
    // Crear el comando para generar campañas
    const command = CommandFactory.createCommand({
      task: 'create growth campaign',
      userId: effectiveUserId,
      site_id: siteId,
      description: 'Create marketing or growth campaigns',
      agentId: effectiveAgentId,
      // Set the target as campaigns structure
      targets: [
        {
          campaigns: [
            {
              title: "Campaign title",
              description: "Campaign description",
              type: "Campaign type (inbound, outbound, etc.)",
              priority: "Campaign priority (low, medium, high)",
              due_date: "ISO date string format YYYY-MM-DD, example: 2025-05-01",
              budget: {
                currency: "USD",
                allocated: 1000,
                remaining: 1000
              },
              revenue: {
                actual: 0,
                currency: "USD",
                estimated: 3000,
                projected: 5000
              },
              requirements: [
                {
                  title: "Requirement title",
                  description: "Requirement description",
                  instructions: "Instructions to complete the requirement",
                  priority: "Requirement priority (low, medium, high)",
                  budget: "Budget for this specific requirement"
                }
              ]
            }
          ]
        }     
      ],
      context,
      model: 'gpt-4.1',
      modelType: 'openai'
    });
    
    // Enviar el comando para procesamiento
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
    
    // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
    }
    
    // Esperar a que el comando se complete
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
    
    // Usar el UUID obtenido inicialmente si no tenemos uno válido después de la ejecución
    const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    // Verificar el estado del comando ejecutado
    if (!executedCommand) {
      console.log(`❌ No se pudo obtener el comando ${internalCommandId} después de la ejecución`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_NOT_FOUND', 
            message: 'The command could not be found after execution' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Verificar si el comando falló explícitamente
    if (executedCommand.status === 'failed') {
      console.log(`❌ El comando ${internalCommandId} falló con estado: ${executedCommand.status}`);
      console.log(`❌ Error del comando: ${executedCommand.error || 'No hay detalles del error'}`);
      
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_FAILED', 
            message: 'The command failed during execution',
            details: executedCommand.error || 'No additional error details available'
          } 
        },
        { status: 500 }
      );
    }
    
    // Verificar si el comando no se completó dentro del tiempo esperado
    if (!completed) {
      console.log(`⏰ El comando ${internalCommandId} no se completó en el tiempo esperado`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_TIMEOUT', 
            message: 'The command did not complete within the expected time frame' 
          } 
        },
        { status: 500 }
      );
    }
    
    console.log(`✅ Comando completado con estado: ${executedCommand.status}, procesando resultados...`);
    console.log(`🔍 Se encontraron ${executedCommand.results?.length || 0} resultados en el comando`);
    
    // Verificar explícitamente si hay resultados antes de procesar
    if (!executedCommand.results || !Array.isArray(executedCommand.results) || executedCommand.results.length === 0) {
      console.log(`⚠️ El comando ${internalCommandId} no produjo resultados`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_RESULTS', 
            message: 'The command completed but did not produce any results' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Crear las campañas a partir de los resultados
    const createdCampaigns = await createCampaignsFromResults(executedCommand, siteId, effectiveUserId, effectiveDbUuid);
    
    if (createdCampaigns.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_CAMPAIGNS_CREATED', 
            message: 'No campaigns could be created from the command results' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Devolver respuesta exitosa con las campañas creadas
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          commandId: effectiveDbUuid || internalCommandId,
          campaigns: createdCampaigns
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