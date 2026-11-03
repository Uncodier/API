import type { HarnessTool } from '@/lib/harness/types';
import { isRequirementDiagnosticRead } from './requirement-operation';

/** Selection is host-owned; model fields called recoveryPolicy are not authority. */
export function requirementRecoveryPolicy(name: string, args: Record<string, unknown>, tools: Map<string, HarnessTool>) {
  if (isRequirementDiagnosticRead(name, args) || (name === 'tools' && ['list', 'describe'].includes(String(args.action)))) return 'read' as const;
  const target = name === 'tools' && args.action === 'call' && typeof args.name === 'string' ? args.name : name;
  const tool = tools.get(target);
  if (tool?.effect === 'read') return 'read' as const;
  let parameters = args;
  if (target !== name) {
    try {
      const nested = typeof args.args === 'string' ? JSON.parse(args.args) : args.args;
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return 'verify_external' as const;
      parameters = nested as Record<string, unknown>;
    } catch { return 'verify_external' as const; }
  }
  const policy = typeof tool?.recoveryPolicy === 'function' ? tool.recoveryPolicy(parameters) : tool?.recoveryPolicy;
  return policy === 'inspect' || policy === 'retry_safe' ? policy : 'verify_external' as const;
}

export const REQUIREMENT_RECOVERY_GUIDANCE = 'Recover using tool results, paginated history and current state; no reconciliation tool is required. Read failures can be retried. For inspect-policy edits, read affected files/diffs and issue a fresh correction against current content, including partially applied batches. retry_safe applies only to host adapters guaranteeing idempotency across attempts. For arbitrary commands, inspect process status/output and effects before acting; shell commands can have external effects. For unknown external writes, do not repeat or change arguments to evade a duplicate-effect guard. Continue independent work and report unresolved effects honestly. Never infer success from missing logs.';