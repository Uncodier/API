import { createHash } from 'node:crypto';

const prefix = 'channel-message-';

export function channelMessageWorkflowId(provider: string, site: string, channel: string, connection: string, event: string) {
  return prefix + createHash('sha256').update(JSON.stringify([provider, site, channel, connection, event])).digest('hex');
}

export function isChannelMessageWorkflowId(id: string) {
  return id.startsWith(prefix) && /^[a-f0-9]{64}$/.test(id.slice(prefix.length));
}