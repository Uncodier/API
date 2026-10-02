import { getSenderAgent, listAgentTools, updateAgent } from "./agent-client";

/** Instruction-only calls must not dial with a stale, metadata-only agent. */
export async function requireVoiceExecutionContextSupport(senderId: string): Promise<void> {
  const agent = await getSenderAgent(senderId);
  const tools = await listAgentTools(agent.id);
  if (!tools.some(tool => tool.name === 'get_call_context' && tool.enabled !== false)
    || !agent.systemPrompt?.includes('First silently call get_call_context')) {
    throw Object.assign(new Error('Voice context support requires an agent/tool re-sync before this follow-up can be placed'), { status: 409 });
  }
}

export async function ensureVoiceContactMetadataEnabled(
  senderId: string
): Promise<void> {
  const agent = await getSenderAgent(senderId);
  if (agent.includeContactMetadata === true) return;
  await updateAgent(agent.id, { includeContactMetadata: true });
}
