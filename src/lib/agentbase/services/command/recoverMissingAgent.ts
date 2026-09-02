import { DbCommand } from '../../models/types';
import { ensureDefaultAgents, findActiveAgentForRole } from '@/lib/services/agents/ensureDefaultAgents';

export function getCommandAgentRole(command: DbCommand): string | undefined {
  return command.agent_role || command.metadata?.agent_role;
}

export async function recoverMissingAgent(command: DbCommand): Promise<DbCommand> {
  if (command.agent_id) {
    return command;
  }

  const agentRole = getCommandAgentRole(command);
  if (!command.site_id || !command.user_id || !agentRole) {
    return command;
  }

  console.log(
    `[recoverMissingAgent] Command ${command.id} missing agent_id. Ensuring defaults for site ${command.site_id}, role "${agentRole}"`
  );

  await ensureDefaultAgents(command.site_id, command.user_id);
  const agent = await findActiveAgentForRole(command.site_id, agentRole);

  if (!agent) {
    console.error(
      `[recoverMissingAgent] No active agent for role "${agentRole}" after ensureDefaultAgents (site ${command.site_id})`
    );
    return command;
  }

  console.log(`[recoverMissingAgent] Attached agent ${agent.agentId} (${agent.role}) to command ${command.id}`);

  return {
    ...command,
    agent_id: agent.agentId,
    agent_role: agentRole,
    metadata: {
      ...(command.metadata || {}),
      agent_role: agentRole,
    },
  };
}
