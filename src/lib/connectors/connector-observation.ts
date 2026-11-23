import type { ToolOrigin } from './connector-discovery-types';

// A lossy diagnostic, not a dispatch decision or receipt. All emitted strings
// come from this module's enums, never account IDs, labels, slugs or queries.
type Observation = { action: 'call' | 'describe' | 'search' | 'list' | 'get' | 'connector'; private_arguments: true; tool_origin?: ToolOrigin };
const facade = 'use_composio_tools';
const unreadable = Symbol('unreadable');
function field(object: unknown, key: string): unknown {
  if (!object || typeof object !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor ? ('value' in descriptor && descriptor.value !== undefined ? descriptor.value : unreadable) : undefined;
}
function fromJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= 64 * 1024) {
    try { return JSON.parse(value); } catch { /* Older observations may be truncated JSON. */ }
  }
  return unreadable;
}
function reservedOrigin(ref: unknown): ToolOrigin | undefined {
  // Malformed qualifications are still private. The unqualified native `report` is not.
  if (typeof ref !== 'string') return;
  if (/^\s*report\s*:/i.test(ref)) return 'makinari_report';
  if (/^\s*connector\s*:/i.test(ref)) return 'provider';
}
export function observedToolName(name: string): string {
  return reservedOrigin(name) ? 'tools' : name;
}
function projection(action?: unknown, origin?: unknown): Observation {
  return { action: action === 'execute' || action === 'call' ? 'call'
    : action === 'describe' || action === 'search' || action === 'list' || action === 'get' ? action : 'connector',
    private_arguments: true, ...(origin === 'provider' || origin === 'makinari_report' ? { tool_origin: origin } : {}) };
}

// Walk only the gateway's real DTO fields, not arbitrary business data, with
// bounded work and no getters. A mixed native/provider page contains account metadata.
function privateInventory(result: unknown, action: unknown): boolean {
  let payload = fromJson(result);
  if (field(payload, 'output') !== undefined) payload = fromJson(field(payload, 'output')); // persisted instance log
  if (action === 'get') {
    if (payload === unreadable) return true;
    const entries = field(field(payload, 'connector_capabilities'), 'capabilities');
    return entries !== undefined && (!Array.isArray(entries) || entries.length > 0);
  }
  if (action !== 'search' && action !== 'list') return false;
  if (payload == null || typeof payload !== 'object') return true; // no inspectable native-only result
  if (field(payload, 'connector_next_cursor') != null) return true;
  // The scoped router does not echo `query` when a server-pinned account suppresses native search.
  if (action === 'search' && field(payload, 'connector_status') !== undefined && field(payload, 'query') === undefined) return true;
  const tools = field(payload, 'tools');
  if (tools === undefined) return false;
  if (!Array.isArray(tools) || tools.length > 512) return true;
  for (let i = 0; i < tools.length; i++) {
    const item = field(tools, String(i));
    if (item === unreadable || reservedOrigin(field(item, 'name')) ||
      ['connector_id', 'account_label', 'tool_origin'].some(key => field(item, key) !== undefined)) return true;
  }
  return false;
}

export function connectorObservation(name: unknown, args: unknown, result?: unknown): Observation | undefined {
  const direct = reservedOrigin(name);
  if (!direct && name !== 'tools' && name !== 'tool_lookup' && name !== facade && name !== 'skill_lookup') return;
  try {
    const input = fromJson(args);
    const action = field(input, 'action');
    if (direct) return projection('call', direct);
    if (name === 'skill_lookup') return (field(input, 'private_arguments') === true || privateInventory(result, action === 'get' ? action : undefined)) ? projection('get') : undefined;
    if (input == null && name !== facade) {
      // Some older native rows store only a result. Absence of arguments alone
      // does not make those private; check the catalog/descriptor envelope.
      const payload = fromJson(field(result, 'output') ?? result);
      const qualified = reservedOrigin(field(payload, 'name'));
      return qualified || field(payload, 'tool_origin') !== undefined || field(payload, 'connector_id') !== undefined ||
        (result != null && privateInventory(result, 'search')) ? projection(undefined, qualified) : undefined;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return projection();
    const target = field(input, 'name');
    if (name !== facade && target === facade && action === 'call') {
      return connectorObservation(facade, field(input, 'args'));
    }
    const ref = name === facade ? field(input, 'action_name') ?? target : target;
    const qualified = reservedOrigin(ref);
    const origin = field(input, 'tool_origin');
    if (qualified || origin !== undefined || name === facade || target === facade ||
      (ref !== undefined && typeof ref !== 'string') || ['private_arguments', 'connector_id', 'catalog_query', 'connector_cursor'].some(key => field(input, key) !== undefined)) {
      // A qualified reference identifies the attempted target even when a contradictory filter will be rejected.
      return projection(action, qualified ?? origin ?? ((action === 'search' || action === 'list') && (name === facade || field(input, 'connector_id') !== undefined) ? 'provider' : undefined));
    }
    if ((action === 'search' || action === 'list') && reservedOrigin(field(input, 'query'))) return projection(action, reservedOrigin(field(input, 'query')));
    if (privateInventory(result, action)) return projection(action);
  } catch { return projection(); } // revoked proxy or uninspectable wrapper: never log the original
}
