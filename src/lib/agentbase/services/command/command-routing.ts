import { rolloutEnabled, routingStorageEnabled } from '@/lib/integrations/openrouter/types';
import { CustomerRoutingError, getExecutionRouting, withExecutionRouting,
  withCustomerOperation, type ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';
import type { CreateCommandParams, DbCommand } from '../../models/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Request metadata/user_id are not execution authorization. Only host scope may select a payer. */
export function admitCommandRouting(command: CreateCommandParams): ExecutionRoutingReference | undefined {
  const inherited = getExecutionRouting();
  if (inherited) {
    if (command.site_id !== inherited.siteId) throw new CustomerRoutingError('ROUTING_SITE_MISMATCH');
    return inherited;
  }
  if (rolloutEnabled()) throw new CustomerRoutingError('COMMAND_AUTHORIZED_ROUTING_REQUIRED');
  return command.site_id ? { payer: 'platform', siteId: command.site_id } : undefined;
}

async function database() { return (await import('@/lib/database/supabase-server')).supabaseAdmin; }

export async function pinCommandRouting(command: DbCommand, routing: ExecutionRoutingReference | undefined): Promise<void> {
  if (!routing) return;
  if (!routingStorageEnabled() && !rolloutEnabled()) {
    if (routing.payer === 'customer') throw new CustomerRoutingError('COMMAND_ROUTING_STORAGE_REQUIRED');
    return;
  }
  if (!UUID.test(command.id) || command.site_id !== routing.siteId) {
    throw new CustomerRoutingError('COMMAND_ROUTING_IDENTITY_REQUIRED');
  }
  const db = await database();
  const { error } = await db.rpc('openrouter_command_routing_pin', {
    p_command_id: command.id, p_site_id: routing.siteId, p_routing: routing,
  });
  if (error) {
    throw new CustomerRoutingError('COMMAND_ROUTING_PERSIST_FAILED');
  }
}

export async function withCommandRouting<T>(command: DbCommand, operation: () => Promise<T>, phase = 'execute'): Promise<T> {
  const parent = getExecutionRouting();
  if (!command.site_id) {
    if (parent || rolloutEnabled()) throw new CustomerRoutingError('COMMAND_ROUTING_SITE_REQUIRED');
    return operation(); // Legacy site-less work cannot select a customer connection.
  }
  let routing: ExecutionRoutingReference;
  if (!routingStorageEnabled() && !rolloutEnabled()) {
    if (parent?.payer === 'customer') throw new CustomerRoutingError('COMMAND_ROUTING_STORAGE_REQUIRED');
    routing = { payer: 'platform', siteId: command.site_id };
  } else if (!UUID.test(command.id)) {
    if (rolloutEnabled() || parent?.payer === 'customer') throw new CustomerRoutingError('COMMAND_ROUTING_IDENTITY_REQUIRED');
    routing = { payer: 'platform', siteId: command.site_id };
  } else {
    const db = await database();
    const { data, error } = await db.from('openrouter_command_routing').select('routing')
      .eq('command_id', command.id).eq('site_id', command.site_id).maybeSingle();
    if (error || !data?.routing) throw new CustomerRoutingError('COMMAND_ROUTING_PIN_REQUIRED');
    routing = data.routing;
  }
  return withExecutionRouting(routing, command.site_id,
    () => withCustomerOperation(`command:${command.id}:${phase}`, operation, { durableBoundary: true }));
}