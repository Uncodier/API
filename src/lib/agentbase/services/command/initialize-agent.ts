import { Base } from '../../agents/Base';
import { DbCommand } from '../../models/types';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { CommandCache } from './CommandCache';
import { recoverMissingAgent } from './recoverMissingAgent';

type InitializeAgentDeps = {
  processors: Record<string, Base | undefined>;
  generateEnhancedAgentBackground: (
    processor: Base,
    agentId: string,
    siteId?: string,
    commandId?: string
  ) => Promise<string>;
  updateCommand: (id: string, updates: Partial<DbCommand>) => Promise<unknown>;
};

export async function initializeAgentCommand(
  command: DbCommand,
  deps: InitializeAgentDeps
): Promise<DbCommand> {
  if (command.agent_background) {
    if (command.agent_background.length < 50) {
      console.warn(`⚠️ [CommandProcessor] agent_background demasiado corto (${command.agent_background.length} caracteres)`);
    } else {
      return command;
    }
  }

  if (!command.agent_id) {
    command = await recoverMissingAgent(command);
    if (command.agent_id) {
      try {
        await DatabaseAdapter.updateCommand(command.id, { agent_id: command.agent_id });
      } catch (persistError) {
        console.error(`❌ [CommandProcessor] Failed to persist recovered agent_id:`, persistError);
      }
    }
  }

  if (command.agent_id) {
    let processor: Base | null = null;

    if (deps.processors[command.agent_id]) {
      processor = deps.processors[command.agent_id] || null;
    } else if (DatabaseAdapter.isValidUUID(command.agent_id)) {
      processor = deps.processors['tool_evaluator'] || null;
    } else {
      const errorMsg = `[CommandProcessor] agent_id inválido o no reconocido: ${command.agent_id}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    if (!processor) {
      const errorMsg = `[CommandProcessor] No se pudo obtener un procesador para el agent_id: ${command.agent_id}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    try {
      const agentBackground = await deps.generateEnhancedAgentBackground(
        processor,
        command.agent_id,
        command.site_id,
        command.id
      );

      command = {
        ...command,
        agent_background: agentBackground,
      };

      try {
        await DatabaseAdapter.updateCommand(command.id, {
          agent_background: agentBackground,
        });
      } catch (dbError) {
        console.error(`❌ [CommandProcessor] Error al guardar agent_background en BD:`, dbError);

        try {
          await deps.updateCommand(command.id, {
            agent_background: agentBackground,
          });
        } catch (cmdError: unknown) {
          console.error(`❌ [CommandProcessor] Error crítico al guardar agent_background:`, cmdError);
        }
      }

      CommandCache.setAgentBackground(command.id, agentBackground);
    } catch (error: unknown) {
      console.error(`❌ [CommandProcessor] Error generando agent_background:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error generando agent_background: ${errorMessage}`);
    }
  } else {
    const errorMsg = `[CommandProcessor] El comando ${command.id} no tiene agent_id ni agent_background`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  return command;
}
