import { OUTSTAND_NETWORKS } from '@/lib/integrations/outstand/social-networks';
import { parseDeliveryRoutes, type DeliveryRoute } from './delivery-routing';

const MODES: Record<string, Pick<DeliveryRoute, 'channel' | 'audience_email_mode' | 'voice_mode'>> = {
  email: { channel: 'email', audience_email_mode: 'mail' },
  mail: { channel: 'email', audience_email_mode: 'mail' },
  newsletter: { channel: 'email', audience_email_mode: 'newsletter' },
  whatsapp: { channel: 'whatsapp' }, telegram: { channel: 'telegram' }, sms: { channel: 'sms' },
  voice: { channel: 'voice', voice_mode: 'tts' }, 'voice-agent-call': { channel: 'voice', voice_mode: 'agent_call' },
};
const NON_ROUTED = new Set(['blog', 'audio', 'message', 'mensaje']);
const ROUTING_KEYS = ['from', 'channel', 'connection_id', 'delivery_routes', 'audience_email_mode', 'voice_mode', 'social_accounts', 'social_account_targets'];

const PUBLISH_NODE_TOOLS = new Set([
  'publish', 'sendBulkMessages', 'social_media_accounts', 'social_media_posts', 'social_media_analytics',
  'messages', 'conversations', 'memories', 'skill_lookup', 'external_skill_lookup',
  'plan_result', 'report', 'instance_history', 'instance_logs', 'audience',
]);

/** Publish nodes cannot bypass destinations via another outbound/integration tool. */
export function assertPublishNodeToolAllowed(name: string) {
  if (!PUBLISH_NODE_TOOLS.has(name)) throw new Error('Bound publish nodes must deliver through publish or sendBulkMessages; alternative mutation tools are not allowed.');
}

export function enforcePublishDestinationArgs(args: Record<string, unknown>, override: Record<string, unknown>, toolName: string) {
  const result = { ...args };
  for (const key of ROUTING_KEYS) delete result[key];
  Object.assign(result, override);
  if (toolName === 'publish' && result.instagram_dm !== undefined) throw new Error('Instagram DM is not a saved publish destination.');
  if (toolName === 'publish' && !Object.hasOwn(override, 'social_accounts')) delete result.tiktok;
  if (toolName === 'sendBulkMessages' && !override.channel && !override.delivery_routes) throw new Error('No saved audience delivery destinations are selected.');
  return result;
}

export function parsePublishDestinations(value: unknown): { social_accounts: string[]; social_account_targets: { id: string; network: string }[]; delivery_routes: DeliveryRoute[] } {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid saved publish destinations.');
  const socials: string[] = [];
  const socialTargets: { id: string; network: string }[] = [];
  const routes: DeliveryRoute[] = [];
  for (const destination of value) {
    if (typeof destination !== 'string' || !destination || destination.length > 1000
      || destination.trim() !== destination || /[\x00-\x1f\x7f]/.test(destination)) throw new Error('Invalid saved publish destination.');
    const match = /^([^:]+):(connection|social):(.+)$/.exec(destination);
    if (match) {
      let id: string;
      try { id = decodeURIComponent(match[3]); } catch { throw new Error('Invalid encoded publish destination ID.'); }
      if (!id || id.length > 200 || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Invalid publish destination ID.');
      if (match[2] === 'connection' && Object.hasOwn(MODES, match[1])) routes.push({ ...MODES[match[1]], connection_id: id });
      else if (match[2] === 'social' && Object.prototype.hasOwnProperty.call(OUTSTAND_NETWORKS, match[1])) {
        socials.push(id); socialTargets.push({ id, network: match[1] });
      }
      else throw new Error('Unknown publish destination type.');
    } else if (Object.hasOwn(MODES, destination)) routes.push({ ...MODES[destination] });
    else if (Object.prototype.hasOwnProperty.call(OUTSTAND_NETWORKS, destination)) socials.push(destination);
    else if (!NON_ROUTED.has(destination)) throw new Error('Unknown saved publish destination.');
  }
  return { social_accounts: Array.from(new Set(socials)), social_account_targets: socialTargets, delivery_routes: routes.length ? parseDeliveryRoutes({ delivery_routes: routes }) : [] };
}

export function bindPublishDestinations(toolOverrides: Record<string, Record<string, unknown>> | undefined, destinations: unknown) {
  const parsed = parsePublishDestinations(destinations);
  const routing = parsed.delivery_routes.length === 1 ? { ...parsed.delivery_routes[0] }
    : parsed.delivery_routes.length ? { delivery_routes: parsed.delivery_routes } : {};
  const result = { ...toolOverrides };
  for (const name of ['publish', 'sendBulkMessages']) {
    const override = { ...result[name] };
    for (const key of ROUTING_KEYS) delete override[key];
    result[name] = { ...override, ...routing,
      ...(name === 'publish' && parsed.social_accounts.length ? { social_accounts: parsed.social_accounts } : {}),
      ...(name === 'publish' && parsed.social_account_targets.length ? { social_account_targets: parsed.social_account_targets } : {}),
    };
  }
  return { ...parsed, toolOverrides: result };
}