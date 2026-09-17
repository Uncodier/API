import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { BacklogItem } from './requirement-backlog-types';

export type RequirementScopePolicy = {
  strict: boolean;
  reason: string;
};

export type RequirementScopeRecord = {
  budget?: unknown;
  metadata?: unknown;
};

const SCOPE_CONSTRAINT_RE =
  /\b(?:must not add|do not add|fixed scope|strict scope|out of scope|no (?:agregar|añadir)|fuera de alcance)\b|\b(?:only|solo|únicamente)\b.{0,50}\b(?:routes?|pages?|screens?|features?|scope|deliverables?|rutas?|páginas?|pantallas?|funcionalidades?|alcance)\b/i;

function hasExplicitBudget(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function hasStrictMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const value = metadata as Record<string, unknown>;
  const policy = String(
    value.scope_policy ?? value.scope_mode ?? value.budget_mode ?? '',
  ).toLowerCase();
  const constraints = Array.isArray(value.extracted_constraints)
    ? value.extracted_constraints.filter(
        (constraint): constraint is string => typeof constraint === 'string',
      )
    : [];
  return (
    value.strict_scope === true ||
    value.fixed_scope === true ||
    value.allow_scope_expansion === false ||
    ['strict', 'fixed', 'closed'].includes(policy) ||
    constraints.some((constraint) => SCOPE_CONSTRAINT_RE.test(constraint))
  );
}

function hasScopeConstraint(item: BacklogItem): boolean {
  return (item.constraints || []).some((constraint) =>
    SCOPE_CONSTRAINT_RE.test(constraint),
  );
}

export function classifyRequirementScopePolicy(
  item: BacklogItem | null | undefined,
  requirement: RequirementScopeRecord = {},
): RequirementScopePolicy {
  if (
    item &&
    (item.scope_level === 'mvp' || item.scope_level === 'minimal')
  ) {
    return {
      strict: true,
      reason: `active backlog item scope is ${item.scope_level}`,
    };
  }
  if (item && hasScopeConstraint(item)) {
    return {
      strict: true,
      reason: 'active backlog item declares strict scope constraints',
    };
  }
  if (hasExplicitBudget(requirement.budget)) {
    return {
      strict: true,
      reason: 'requirement has an explicit budget',
    };
  }
  if (hasStrictMetadata(requirement.metadata)) {
    return {
      strict: true,
      reason: 'requirement metadata disallows scope expansion',
    };
  }
  return {
    strict: false,
    reason: 'requirement allows backlog expansion',
  };
}

export async function resolveRequirementScopePolicy(
  requirementId: string,
  item?: BacklogItem | null,
): Promise<RequirementScopePolicy> {
  const itemPolicy = classifyRequirementScopePolicy(item);
  if (itemPolicy.strict) return itemPolicy;

  const { data, error } = await supabaseAdmin
    .from('requirements')
    .select('budget, metadata')
    .eq('id', requirementId)
    .maybeSingle();
  if (error) {
    console.warn(
      `[RequirementScopePolicy] Could not load requirement ${requirementId}: ${error.message}`,
    );
    return { strict: false, reason: 'scope metadata unavailable' };
  }
  return classifyRequirementScopePolicy(item, {
    budget: data?.budget,
    metadata: data?.metadata,
  });
}
