import { getSiteLicensedResources } from '@/lib/billing/licensed-resources';
import { selectedOutreachAccounts, type OutreachAccount, type OutreachPolicy } from '@/lib/services/outreach/policy';

export const DELIVERY_CHANNELS = ['whatsapp', 'email', 'telegram', 'sms', 'voice'] as const;
export type DeliveryChannel = typeof DELIVERY_CHANNELS[number];
export interface DeliveryRoute {
  channel: DeliveryChannel;
  connection_id?: string;
  audience_email_mode?: 'mail' | 'newsletter';
  voice_mode?: 'tts' | 'agent_call';
}
export interface DeliveryRoutingInput {
  channel?: DeliveryChannel;
  connection_id?: string;
  audience_email_mode?: 'mail' | 'newsletter';
  voice_mode?: 'tts' | 'agent_call';
  delivery_routes?: DeliveryRoute[];
}
export const DELIVERY_ROUTING_PROPERTIES = {
  connection_id: { type: 'string', description: 'Exact active site connection ID. Legacy IDs: legacy:email, legacy:agent_email, legacy:whatsapp, legacy:agent_whatsapp. Never infer or invent an ID.' },
  delivery_routes: {
    type: 'array', minItems: 1, maxItems: 20,
    description: 'All selected delivery destinations. Mutually exclusive with top-level channel/connection_id/modes. Every route is validated before any write or send.',
    items: {
      type: 'object', additionalProperties: false, required: ['channel'],
      properties: {
        channel: { type: 'string', enum: DELIVERY_CHANNELS },
        connection_id: { type: 'string' },
        audience_email_mode: { type: 'string', enum: ['mail', 'newsletter'] },
        voice_mode: { type: 'string', enum: ['tts', 'agent_call'] },
      },
    },
  },
};

export function parseDeliveryRoutes(input: DeliveryRoutingInput): DeliveryRoute[] {
  if (input.delivery_routes !== undefined && ['channel', 'connection_id', 'audience_email_mode', 'voice_mode']
    .some(key => input[key as keyof DeliveryRoutingInput] !== undefined)) {
    throw new Error('delivery_routes cannot be combined with top-level delivery routing fields.');
  }
  const routes = input.delivery_routes ?? (input.channel ? [{
    channel: input.channel, connection_id: input.connection_id,
    audience_email_mode: input.audience_email_mode, voice_mode: input.voice_mode,
  }] : []);
  if (!Array.isArray(routes) || !routes.length || routes.length > 20) throw new Error('Provide 1 to 20 delivery routes.');
  const seen = new Set<string>();
  return routes.map(route => {
    if (!route || typeof route !== 'object' || Array.isArray(route)
      || Object.keys(route).some(key => !['channel', 'connection_id', 'audience_email_mode', 'voice_mode'].includes(key))
      || !DELIVERY_CHANNELS.includes(route.channel)) throw new Error('Invalid delivery route channel or fields.');
    if (route.connection_id !== undefined && (typeof route.connection_id !== 'string'
      || !route.connection_id || route.connection_id.length > 200 || route.connection_id.trim() !== route.connection_id
      || /[\x00-\x1f\x7f]/.test(route.connection_id))) throw new Error('Invalid connection_id.');
    if (route.audience_email_mode !== undefined && (route.channel !== 'email'
      || !['mail', 'newsletter'].includes(route.audience_email_mode))) throw new Error('audience_email_mode is only valid for email (mail or newsletter).');
    if (route.voice_mode !== undefined && (route.channel !== 'voice'
      || !['tts', 'agent_call'].includes(route.voice_mode))) throw new Error('voice_mode is only valid for voice (tts or agent_call).');
    const normalized = { ...route,
      ...(route.channel === 'email' ? { audience_email_mode: route.audience_email_mode ?? 'mail' as const } : {}),
      ...(route.channel === 'voice' ? { voice_mode: route.voice_mode ?? 'tts' as const } : {}),
    };
    const key = JSON.stringify(normalized);
    if (seen.has(key)) throw new Error('Duplicate delivery route.');
    seen.add(key);
    return normalized;
  });
}

function settingsObject(channels: unknown): Record<string, any> {
  if (typeof channels === 'string') {
    try { channels = JSON.parse(channels); } catch { throw new Error('Invalid channel configuration.'); }
  }
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) throw new Error('Channel configuration unavailable.');
  return channels as Record<string, any>;
}

export function resolveDeliveryAccount(channelsValue: unknown, route: DeliveryRoute): OutreachAccount {
  const channels = settingsObject(channelsValue);
  const connections = Array.isArray(channels.connections) ? channels.connections : [];
  const ids = connections.map((c: any) => c?.id);
  if (ids.some((id: unknown, index: number) => typeof id !== 'string' || !id || ids.indexOf(id) !== index
    || id.startsWith('legacy:') || ['email', 'agent_email', 'whatsapp', 'agent_whatsapp'].includes(id))) {
    throw new Error('Invalid, duplicate, or reserved connection identifier in site inventory.');
  }
  const inventoryIds: string[] = [
    ...['email', 'agent_email', 'whatsapp', 'agent_whatsapp'].filter(key => channels[key]),
    ...(Array.isArray(channels.connections) ? channels.connections.map((c: any) => c?.id).filter((id: unknown) => typeof id === 'string') : []),
  ];
  const id = route.connection_id?.startsWith('legacy:') ? route.connection_id.slice(7) : route.connection_id;
  // Reserved legacy identifiers must never alias a real connection.
  if (route.connection_id?.startsWith('legacy:') && !['email', 'agent_email', 'whatsapp', 'agent_whatsapp'].includes(id!)) {
    throw new Error('Unknown legacy connection_id.');
  }
  if (route.connection_id && !route.connection_id.startsWith('legacy:') && ['email', 'agent_email', 'whatsapp', 'agent_whatsapp'].includes(id!)) {
    throw new Error('Use the reserved legacy: prefix for a legacy account.');
  }
  const policy = { channel_accounts: { [route.channel]: id ? [id] : inventoryIds } } as OutreachPolicy;
  const accounts = selectedOutreachAccounts({ channels }, policy, route.channel);
  if (accounts.length !== 1) throw new Error(id
    ? `Selected ${route.channel} connection is missing, inactive, foreign, or wrong-channel.`
    : `Select an exact ${route.channel} connection_id; legacy selection is unavailable or ambiguous.`);
  if (accounts[0].config.license_suspended === true) throw new Error('Selected connection is suspended.');
  return accounts[0];
}

export function resolveDeliveryRoutesFromSettings(channels: unknown, input: DeliveryRoutingInput): DeliveryRoute[] {
  const routes = parseDeliveryRoutes(input).map(route => {
    const account = resolveDeliveryAccount(channels, route);
    return { ...route, connection_id: account.provider === 'zavu' ? account.id : `legacy:${account.id}` };
  });
  const keys = routes.map(route => `${route.channel}:${route.connection_id}:${route.audience_email_mode ?? route.voice_mode ?? ''}`);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate resolved delivery destination.');
  return routes;
}

export async function resolveDeliveryRoutes(siteId: string, input: DeliveryRoutingInput): Promise<DeliveryRoute[]> {
  parseDeliveryRoutes(input);
  if (!siteId) throw new Error('An authorized site is required.');
  const data = await getSiteLicensedResources(siteId);
  return resolveDeliveryRoutesFromSettings(data.channels, input);
}