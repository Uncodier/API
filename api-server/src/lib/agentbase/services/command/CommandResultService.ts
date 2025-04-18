/**
 * CommandResultService - Servicio para manejar los resultados de los comandos
 */
import { DbCommand } from '../../models/types';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { CommandStore } from './CommandStore';
import { NextResponse } from 'next/server';
import { CommandCache } from './CommandCache';

export class CommandResultService {
  /**
   * Actualiza los resultados de un comando
   * 
   * @param commandId ID del comando
   * @param results Nuevos resultados a añadir
   * @returns Comando actualizado o null si no se encontró
   */
  async updateResults(commandId: string, results: any[]): Promise<DbCommand | null> {
    try {
      if (!results || results.length === 0) {
        console.log(`⚠️ No hay resultados para actualizar en comando ${commandId}`);
        return null;
      }
      
      console.log(`🔄 Actualizando resultados para comando ${commandId}: ${results.length} resultados`);
      
      // Get current command
      const command = CommandStore.getCommand(commandId);
      
      if (!command) {
        console.error(`Command not found: ${commandId}`);
        return null;
      }
      
      // MODIFICACIÓN: Reemplazar resultados en lugar de combinar
      const updatedCommand = { 
        ...command, 
        results: results, // Usar directamente los nuevos resultados
        updated_at: new Date().toISOString()
      };
      
      console.log(`🔄 Comando ahora tiene ${updatedCommand.results.length} resultados total`);
      
      // Store in command registry
      CommandStore.setCommand(commandId, updatedCommand);
      
      // Actualizar en caché para asegurar su disponibilidad en todo el flujo
      const cachedCommand = CommandCache.getCachedCommand(commandId);
      if (cachedCommand) {
        // MODIFICACIÓN: Usar updateCachedCommand pero con la lógica ya corregida
        CommandCache.updateCachedCommand(commandId, {
          results: updatedCommand.results
        });
        console.log(`✅ Resultados actualizados en caché: ${updatedCommand.results.length} resultados totales`);
      } else {
        // Si no está en caché, guardar para futuras consultas
        CommandCache.cacheCommand(commandId, updatedCommand);
        console.log(`✅ Comando y resultados guardados en caché: ${updatedCommand.results.length} resultados`);
      }
      
      // Try to update in database if UUID is available
      if (command.metadata?.dbUuid && DatabaseAdapter.isValidUUID(command.metadata.dbUuid)) {
        try {
          console.log(`✅ Enviando ${updatedCommand.results.length} resultados a la base de datos (via metadata UUID: ${command.metadata.dbUuid})`);
          
          await DatabaseAdapter.updateCommand(command.metadata.dbUuid, {
            results: updatedCommand.results
          });
          console.log(`✅ Resultados actualizados en BD (via metadata): ${command.metadata.dbUuid}, total: ${updatedCommand.results.length}`);
        } catch (error) {
          console.error(`❌ Error actualizando resultados en BD via metadata: ${error}`);
        }
      } 
      // Intentar directamente con el ID si parece ser un UUID
      else if (DatabaseAdapter.isValidUUID(commandId)) {
        try {
          console.log(`✅ Enviando ${updatedCommand.results.length} resultados a la base de datos (via ID: ${commandId})`);
          
          await DatabaseAdapter.updateCommand(commandId, {
            results: updatedCommand.results
          });
          console.log(`✅ Resultados actualizados en BD (via ID): ${commandId}, total: ${updatedCommand.results.length}`);
        } catch (error) {
          console.error(`❌ Error actualizando resultados en BD via ID: ${error}`);
        }
      }
      
      return updatedCommand;
    } catch (error) {
      console.error(`❌ Error actualizando resultados: ${error}`);
      return null;
    }
  }

  /**
   * Maneja la finalización de un comando y prepara la respuesta
   * 
   * @param commandId ID del comando
   * @param dbUuid UUID en la base de datos
   * @returns Respuesta HTTP
   */
  async handleCommandCompletion(commandId: string, dbUuid: string): Promise<NextResponse> {
    try {
      // Get current command state
      const command = CommandStore.getCommand(commandId);
      
      if (!command) {
        throw new Error(`Command not found: ${commandId}`);
      }

      // Actualizar status si no está ya completado
      if (command.status !== 'completed') {
        command.status = 'completed';
        command.updated_at = new Date().toISOString();
        CommandStore.setCommand(commandId, command);
        
        // Intentar actualizar en base de datos
        if (DatabaseAdapter.isValidUUID(dbUuid)) {
          try {
            await DatabaseAdapter.updateCommand(dbUuid, { status: 'completed' });
          } catch (error) {
            console.error(`Error updating command status in database: ${error}`);
          }
        }
      }
      
      console.log(`🔄 Estado final del comando: ${command.status}`);
      
      // Obtain results if they exist
      const results = command.results || [];
      console.log(`📊 Resultados obtenidos (${results.length}): ${JSON.stringify(results.slice(0, 1)).substring(0, 200)}...`);
      
      const messageResults = results.filter((r: any) => r.type === 'message');
      const toolResults = results.filter((r: any) => r.type === 'tool_evaluation');
      
      // Log information about found results
      console.log(`📊 Resultados encontrados: ${results.length} totales, ${messageResults.length} mensajes, ${toolResults.length} evaluaciones de herramientas`);
      
      // Extract response message content
      let responseMessage = 'Command processed successfully';
      if (messageResults.length > 0 && messageResults[0].content) {
        const content = messageResults[0].content;
        responseMessage = typeof content === 'string' 
          ? content 
          : (content.content || responseMessage);
        
        console.log(`💬 Mensaje de respuesta encontrado: ${responseMessage.substring(0, 100)}...`);
      }

      // Return success response with complete information
      return NextResponse.json({
        success: true,
        data: {
          commandId,
          dbUuid,
          status: command.status,
          message: responseMessage,
          resultsCount: results.length,
          messageResultsCount: messageResults.length,
          toolResultsCount: toolResults.length,
          completedAt: command.updated_at
        }
      });
    } catch (error: any) {
      console.error(`Error handling command completion: ${error.message}`);
      
      // Return an error response
      return NextResponse.json({
        success: false,
        data: {
          commandId,
          dbUuid,
          status: 'failed',
          message: `Error: ${error.message}`,
          error: error.message
        }
      });
    }
  }
} 