import { ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función para validar UUIDs
export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Inicializar el agente y obtener el servicio de comandos
let commandServiceInstance: any = null;

export function getCommandService() {
  if (!commandServiceInstance) {
    const processorInitializer = ProcessorInitializer.getInstance();
    processorInitializer.initialize();
    commandServiceInstance = processorInitializer.getCommandService();
  }
  return commandServiceInstance;
}

// Función para obtener el UUID de la base de datos para un comando
export async function getCommandDbUuid(internalId: string): Promise<string | null> {
  try {
    const commandService = getCommandService();
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
      const commandService = getCommandService();
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

// Función para esperar a que un comando se complete con mejor manejo de errores
export async function waitForCommandCompletion(commandId: string, maxAttempts = 120, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  let dbUuid: string | null = null;
  let consecutiveErrors = 0;
  let stuckInPendingCount = 0;
  
  console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
  
  // Crear una promesa que se resuelve cuando el comando se completa o se agota el tiempo
  return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        // Primero intentar obtener desde la caché para obtener agent_background
        const { CommandCache } = await import('@/lib/agentbase/services/command/CommandCache');
        const cachedCommand = CommandCache.getCachedCommand(commandId);
        
        // Luego obtener desde BD para estado actualizado
        const commandService = getCommandService();
        executedCommand = await commandService.getCommandById(commandId);
        
        // Reset consecutive errors on successful fetch
        consecutiveErrors = 0;
        
        if (!executedCommand) {
          console.log(`⚠️ No se pudo encontrar el comando ${commandId} (intento ${attempts}/${maxAttempts})`);
          
          // If we can't find the command for too long, give up
          if (attempts > maxAttempts * 0.3) {
            console.error(`❌ Comando ${commandId} no encontrado después de ${attempts} intentos`);
            clearInterval(checkInterval);
            resolve({command: null, dbUuid: null, completed: false});
            return;
          }
          return; // Continue trying
        }
        
        // Si hay comando en caché con agent_background, fusionar con el de BD
        if (cachedCommand?.agent_background && !executedCommand.agent_background) {
          console.log(`🔄 [waitForCommandCompletion] Restaurando agent_background desde caché (${cachedCommand.agent_background.length} caracteres)`);
          executedCommand.agent_background = cachedCommand.agent_background;
        }
        
        // Guardar el UUID de la base de datos si está disponible
        if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
          dbUuid = executedCommand.metadata.dbUuid as string;
          console.log(`🔑 UUID de base de datos encontrado en metadata: ${dbUuid}`);
        }
        
        // Check if command is stuck in pending state
        if (executedCommand.status === 'pending') {
          stuckInPendingCount++;
          
          // If stuck in pending for too long, consider it failed
          if (stuckInPendingCount > maxAttempts * 0.7) {
            console.warn(`⚠️ Comando ${commandId} está estancado en 'pending' por ${stuckInPendingCount} intentos`);
            
            // Check if it has agent_background - if not, it might be truly stuck
            if (!executedCommand.agent_background && !cachedCommand?.agent_background) {
              console.error(`❌ Comando ${commandId} estancado sin agent_background - considerando como fallido`);
              clearInterval(checkInterval);
              resolve({command: executedCommand, dbUuid: dbUuid, completed: false});
              return;
            }
          }
        } else {
          stuckInPendingCount = 0; // Reset if not pending
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
          console.error(`⏰ Tiempo de espera agotado para el comando ${commandId} después de ${maxAttempts} intentos`);
          console.error(`📊 Estadísticas finales: stuckInPending=${stuckInPendingCount}, consecutiveErrors=${consecutiveErrors}`);
          
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
        consecutiveErrors++;
        console.error(`❌ Error al verificar estado del comando ${commandId} (intento ${attempts}/${maxAttempts}, errores consecutivos: ${consecutiveErrors}):`, error);
        
        // If we have too many consecutive errors, give up
        if (consecutiveErrors >= 5) {
          console.error(`❌ Demasiados errores consecutivos (${consecutiveErrors}) para comando ${commandId}, abandonando`);
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid: dbUuid, completed: false});
          return;
        }
        
        // If we've reached max attempts, give up
        if (attempts >= maxAttempts) {
          console.error(`❌ Tiempo de espera agotado con errores para comando ${commandId}`);
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid: dbUuid, completed: false});
          return;
        }
        
        // Continue trying on transient errors
      }
    }, delayMs);
  });
} 