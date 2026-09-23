import { getSenderAgent, updateAgent } from "./agent-client";

export async function ensureVoiceContactMetadataEnabled(
  senderId: string
): Promise<void> {
  const agent = await getSenderAgent(senderId);
  if (agent.includeContactMetadata === true) return;
  await updateAgent(agent.id, { includeContactMetadata: true });
}
