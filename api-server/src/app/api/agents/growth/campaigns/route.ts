import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';

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
      // Esto es un hack para acceder al mapa de traducción interno
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
        
        if (executedCommand.status === 'completed' || executedCommand.status === 'failed') {
          console.log(`✅ Comando ${commandId} completado con estado: ${executedCommand.status}`);
          
          // Intentar obtener el UUID de la base de datos si aún no lo tenemos
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: executedCommand.status === 'completed'});
          return;
        }
        
        console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
          
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

// Función para obtener campañas creadas a partir de un comando
async function getCreatedCampaigns(commandDbUuid: string): Promise<any[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .select(`
        id, 
        title, 
        description,
        status,
        type,
        priority,
        budget,
        requirement_ids
      `)
      .eq('command_id', commandDbUuid);
    
    if (error) {
      console.error('Error al obtener campañas:', error);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('Error al consultar campañas:', error);
    return [];
  }
}

export async function POST(request: Request) {
  console.log('🚀 API Growth Marketing - Campaigns - POST');
  
  try {
    const body = await request.json();
    
    // Validar parámetros requeridos
    if (!body.siteId) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required parameter: siteId'
        }
      }, { status: 400 });
    }
    
    if (!body.totalBudget) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required parameter: totalBudget'
        }
      }, { status: 400 });
    }
    
    if (!body.goals || !Array.isArray(body.goals) || body.goals.length === 0) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing or invalid required parameter: goals (should be a non-empty array)'
        }
      }, { status: 400 });
    }
    
    // Formatear los objetivos de la campaña como texto para la descripción
    const goalsText = body.goals.join(', ');
    
    // Validar y procesar los requisitos
    let processedRequirements = [];
    if (body.requirements && Array.isArray(body.requirements)) {
      // Asegurarnos de que cada requisito tenga un formato adecuado
      processedRequirements = body.requirements.map((req: { id?: string, [key: string]: any }, index: number) => {
        // Si no tiene un ID, generarle uno temporal para referencia
        if (!req.id) {
          req.id = `req_${Date.now()}_${index}`;
        }
        return req;
      });
    }
    
    // Crear un contexto en formato string con toda la información necesaria
    const contextInfo = {
      total_budget: body.totalBudget,
      currency: body.currency || 'USD',
      priority: body.priority || 'high',
      timeframe: body.timeframe || {
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      },
      goals: body.goals,
      industries: body.industries || [],
      competitors: body.competitors || [],
      previousResults: body.previousResults || {},
      segments: body.segmentIds ? body.segmentIds.map((id: string) => ({ title: id })) : []
    };
    
    // Convertir el objeto de contexto a string en formato JSON
    const contextString = `Campaign Creation Context:\n${JSON.stringify(contextInfo, null, 2)}`;
    
    // Crear el objeto de comando para el agente
    const command = CommandFactory.createCommand({
      task: 'create marketing campaigns',
      userId: body.userId,
      agentId: body.agent_id,
      // Agregar site_id directamente como propiedad principal
      site_id: body.siteId,
      description: `Generate marketing campaigns with budget ${body.totalBudget} for goals: ${goalsText}`,
      targets: [
        {
          campaigns: [
            {
              title: "B2B Lead Generation Campaign",
              description: "High-performance search campaign focusing on decision-makers in the B2B software sector",
              budget: "budget assigned for the campaign according to the total budget of the period, example: 2000",
              type: "inbound' | 'outbound' | 'branding' | 'product' | 'events' | 'success' | 'account' | 'community' | 'guerrilla' | 'affiliate' | 'experiential' | 'programmatic' | 'performance' | 'publicRelations",
              priority: "high | medium | low",
              requirements:  [
                {
                  title: "minimal tasks for the campaign to be copmleted",
                  description: "task description",
                  priority: "high | medium | low",
                  instructions: "Rich markdown instructions, for the task",
                  budget: "budget assigned for the task according to the total budget of the campaign, example: 1000"
                }
              ]
            }
          ]
          }
        }
      ],
      // Usar el string como contexto
      context: contextString,
      // Definir los supervisores
      supervisor: [
        {
          agent_role: 'growth_marketer',
          status: 'not_initialized'
        },
        {
          agent_role: 'budget_optimizer',
          status: 'not_initialized'
        }
      ]
    });
    
    console.log('⚙️ Ejecutando comando para crear campañas de marketing...');
    
    // Enviar el comando para su procesamiento
    const internalCommandId = await commandService.submitCommand(command);
    
    if (!internalCommandId) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'COMMAND_EXECUTION_FAILED',
          message: 'Failed to process command'
        }
      }, { status: 500 });
    }
    
    console.log(`📝 Comando creado con ID: ${internalCommandId}`);
    
    // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
    }
    
    // Esperar a que el comando se complete
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
    
    // Usar el UUID obtenido inicialmente si no tenemos uno válido después de la ejecución
    const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    if (!completed || !executedCommand) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'COMMAND_EXECUTION_TIMEOUT',
          message: 'Command execution timed out or failed',
          command_id: internalCommandId,
          db_uuid: effectiveDbUuid
        }
      }, { status: 500 });
    }
    
    // Obtener las campañas creadas
    const campaigns = effectiveDbUuid ? await getCreatedCampaigns(effectiveDbUuid) : [];
    
    return NextResponse.json({
      success: true,
      data: {
        command_id: effectiveDbUuid || internalCommandId,
        site_id: body.siteId,
        campaigns: campaigns
      }
    });
    
  } catch (error: any) {
    console.error('Error en API de Campañas:', error);
    
    return NextResponse.json({
      success: false,
      error: {
        code: 'SYSTEM_ERROR',
        message: error.message || 'Internal server error'
      }
    }, { status: 500 });
  }
} 