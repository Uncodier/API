import toolScreenMap from './tool-screen-map.json';

/** Host-owned scope captured in a closure; never read from model/tool arguments. */
export type ToolScreenScope = { siteId: string; userId?: string };
export type ToolScreenAccess = { isAdmin: boolean; blockedScreens: readonly string[] };
type ToolScreenRule = {
  screens: string[] | null; adminOnly?: boolean; requiresUser?: boolean;
  allowTenantSwitch?: boolean; bindActor?: boolean;
  bindActorActions?: string[];
};
const rules: Readonly<Record<string, ToolScreenRule>> = toolScreenMap.tools;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ToolScreenAccessDenied extends Error {
  readonly code = 'TOOL_SCREEN_ACCESS_DENIED';
  readonly status = 403;
  constructor() { super('Tool access denied by screen permissions.'); }
}

/** Lookup failure, not an authorization decision. Never retain DB details/cause. */
export class ToolScreenAccessUnavailable extends Error {
  readonly name = 'ToolScreenAccessUnavailable';
  readonly code = 'TOOL_SCREEN_ACCESS_UNAVAILABLE';
  readonly status = 503;
  readonly recoverable = true;
  constructor() { super('Tool screen permissions are temporarily unavailable.'); }
}

export function canUseToolScreen(name: string, access: ToolScreenAccess | null): boolean {
  const rule = Object.hasOwn(rules, name) ? rules[name] : undefined;
  if (!rule) return false;
  if (rule.screens === null && !rule.requiresUser && !rule.adminOnly) return true;
  if (!access) return false;
  if (access.isAdmin) return true;
  return !rule.adminOnly && (rule.screens === null || rule.screens.every(screen => !access.blockedScreens.includes(screen)));
}

/** Some legacy wrappers let explicit tenant/actor fields override their closures. */
export function assertToolScopeArgs(name: string, args: unknown, scope?: ToolScreenScope): void {
  const rule = Object.hasOwn(rules, name) ? rules[name] : undefined;
  if (!rule || !args || typeof args !== 'object' || Array.isArray(args)) return;
  const values = args as Record<string, unknown>;
  if (!rule.allowTenantSwitch) {
    for (const field of ['site_id', 'siteId']) {
      if (values[field] != null && values[field] !== scope?.siteId) throw new ToolScreenAccessDenied();
    }
  }
  // user_id is a domain filter on many tools, not necessarily the actor. Bind it
  // only on explicitly mapped wrappers that use it as execution authority.
  if (rule.bindActor || (typeof values.action === 'string' && rule.bindActorActions?.includes(values.action))) {
    for (const field of ['user_id', 'userId']) {
      if (values[field] != null && values[field] !== scope?.userId) throw new ToolScreenAccessDenied();
    }
  }
}

/**
 * Run after host helpers add/replace tools. Do not grant `tools` a blanket JSON
 * exemption: that existing router checks its underlying names on every action.
 * Every other callable definition, including late repair/history tools, gets a
 * fresh guard even if an earlier wrapper short-circuits its old implementation.
 */
export function guardFinalToolCatalog<T extends { name?: string; execute?: (...args: any[]) => any }>(
  tools: T[], scope: ToolScreenScope,
): T[] {
  return tools.map(tool => {
    if (tool.name === 'tools' || typeof tool.execute !== 'function') return tool;
    return guardToolScreen({ ...tool, name: tool.name ?? '', execute: tool.execute }, scope) as T;
  });
}

/**
 * No positive cache: revocation and blocked_screens changes apply on the next call.
 * Null is a denied/missing/invalid principal or permission record. Lookup errors
 * and timeouts reject with ToolScreenAccessUnavailable; neither grants access.
 */
export async function loadToolScreenAccess(scope?: ToolScreenScope): Promise<ToolScreenAccess | null> {
  if (!scope || !UUID.test(scope.siteId) || !scope.userId || !UUID.test(scope.userId)) return null;
  try {
    // Lazy import also keeps screen-independent offline tools free of DB/env initialization.
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const signal = AbortSignal.timeout(5_000);
    const effective = await supabaseAdmin.rpc('site_user_has_effective_access', {
      p_site_id: scope.siteId, p_user_id: scope.userId,
    }).abortSignal(signal);
    if (signal.aborted || effective.error) throw new ToolScreenAccessUnavailable();
    if (effective.data !== true) return null;
    const [site, ownership, membership] = await Promise.all([
      supabaseAdmin.from('sites').select('user_id').eq('id', scope.siteId).abortSignal(signal).maybeSingle(),
      supabaseAdmin.from('site_ownership').select('site_id').eq('site_id', scope.siteId)
        .eq('user_id', scope.userId).abortSignal(signal).maybeSingle(),
      supabaseAdmin.from('site_members').select('role, blocked_screens').eq('site_id', scope.siteId)
        .eq('user_id', scope.userId).eq('status', 'active').abortSignal(signal).maybeSingle(),
    ]);
    if (signal.aborted || site.error || ownership.error || membership.error) throw new ToolScreenAccessUnavailable();
    if (!site.data) return null;
    const isAdmin = site.data.user_id === scope.userId || Boolean(ownership.data)
      || ['owner', 'admin'].includes(membership.data?.role);
    if (isAdmin) return { isAdmin: true, blockedScreens: [] };
    if (!membership.data) return null;
    const blocked = membership.data.blocked_screens;
    // Legacy null means no blocked screens. Malformed permission data never grants access.
    if (blocked != null && (!Array.isArray(blocked) || blocked.some(screen => typeof screen !== 'string'))) return null;
    return { isAdmin: false, blockedScreens: blocked ?? [] };
  } catch {
    throw new ToolScreenAccessUnavailable();
  }
}

export async function assertToolScreenAccess(name: string, scope?: ToolScreenScope): Promise<void> {
  if (!Object.hasOwn(rules, name)) throw new ToolScreenAccessDenied();
  if (canUseToolScreen(name, null)) return;
  if (!canUseToolScreen(name, await loadToolScreenAccess(scope))) throw new ToolScreenAccessDenied();
}

export function guardToolScreen<T extends { name: string; execute: (...args: any[]) => any }>(
  tool: T, scope?: ToolScreenScope,
): T {
  scope = scope ? { siteId: scope.siteId, userId: scope.userId } : undefined;
  return {
    ...tool,
    execute: async (...args: any[]) => {
      try {
        await assertToolScreenAccess(tool.name, scope);
        assertToolScopeArgs(tool.name, args[0], scope);
      } catch (error) {
        // Only this predispatch region proves the underlying execute never ran.
        // The error classes alone (or a matching code) do not establish that.
        if (error instanceof ToolScreenAccessDenied || error instanceof ToolScreenAccessUnavailable) {
          Object.assign(error, { executed: false, effectStarted: false });
        }
        throw error;
      }
      return tool.execute(...args);
    },
  };
}