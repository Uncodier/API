import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { requestChannelReview, type ChannelRequestHost } from './channel-request';

import type { SupportConnectorHost } from './support-runtime-contract';

// Never restore authority from serialized command properties, model arguments or role names.
type Binding = { kind: 'review'; host: ChannelRequestHost } | { kind: 'gateway'; host: SupportConnectorHost };
const pending = new WeakMap<object, Binding>();
const active = new AsyncLocalStorage<(Binding & { commandId: string }) | undefined>();
export function attachChannelRequestHost(command: object, host: ChannelRequestHost) { pending.set(command, { kind: 'review', host }); }

export function attachSupportConnectorHost(command: object, host: SupportConnectorHost) { pending.set(command, { kind: 'gateway', host }); }

export function emitBoundCommand<T>(source: object, saved: { id: string; site_id?: string | null; agent_id?: string | null }, emit: () => T): T {
  const binding = pending.get(source);
  pending.delete(source);
  const bound = binding && saved.site_id === binding.host.siteId && saved.agent_id === binding.host.agentId && z.string().uuid().safeParse(saved.id).success;
  return active.run(bound ? { ...binding, commandId: saved.id } : undefined, emit);
}

function withCommandSource<T extends { source?: import('./approval-source').ApprovalSource }>(scope: T, id: string, digest?: string) {
  return scope.source || !digest ? scope : { ...scope, source: { kind: 'command' as const, id, digest } };
}

function checkedSupportHost(commandId: string, siteId: string, host: SupportConnectorHost): SupportConnectorHost {
  return { ...host, resolve: async () => {
    const scope = await host.resolve();
    if (!scope || scope.siteId !== siteId || scope.agentId !== host.agentId) return null;
    const { isAssignedChannelCommand } = await import('./channel-command-row');
    return await isAssignedChannelCommand(commandId, siteId, host.agentId,
      scope.audience === 'member' ? scope.userId : undefined) ? withCommandSource(scope, commandId, host.messageDigest) : null;
  } };
}

export function requestBoundCommandReview(commandId: string | undefined, siteId: string | undefined, args: unknown) {
  const bound = active.getStore();
  if (!bound || bound.commandId !== commandId || bound.host.siteId !== siteId) return requestChannelReview(undefined, args);
  const host = bound.host;
  return requestChannelReview({ ...host, resolve: async () => {
    if (bound.kind === 'gateway') {
      const scope = await checkedSupportHost(commandId, siteId, bound.host).resolve();
      if (!scope) return null;
      // Private review accepts no caller identity, audience or execution capability.
      const { conversationId, siteId: site, agentId, idempotencyKey, source } = scope;
      return { conversationId, siteId: site, agentId, idempotencyKey, ...(source && {source}), ...(scope.audience === 'member' ? {memberUserId: scope.userId} : scope.audience === 'verified' ? {leadId: scope.leadId} : {}) };
    }
    const { isAssignedChannelCommand } = await import('./channel-command-row');
    const scope = await bound.host.resolve();
    if (!scope || !await isAssignedChannelCommand(commandId, siteId, host.agentId, scope.memberUserId)) return null;
    return withCommandSource(scope, commandId, host.messageDigest);
  } }, args);
}

export async function executeBoundSupportConnector(commandId: string | undefined, siteId: string | undefined, name: string, args: unknown) {
  const bound = active.getStore();
  if (bound?.kind === 'gateway' && bound.commandId === commandId && bound.host.siteId === siteId) {
    const { host } = bound;
    try {
      const { executeSupportConnectorTool } = await import('./support-runtime');
      return await executeSupportConnectorTool(checkedSupportHost(commandId, siteId, host), name, args);
    } catch { /* Never send authorization or provider exception details to a channel. */ }
  }
  return { success: false, status: 'unavailable' };
}
