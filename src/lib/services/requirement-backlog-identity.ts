import type { BacklogItem } from './requirement-backlog-types';
import {
  isDeclaredAcceptanceContract,
  resolveAcceptanceContract,
} from './requirement-acceptance-contract';

function normalizeText(value: string): string {
  // Keep case, punctuation and paths: /Account and /account need not be the
  // same route, and shell commands/semantic assertions may be case-sensitive.
  return value.trim().replace(/\s+/g, ' ');
}

function normalizedTitle(title: string): string {
  return normalizeText(title)
    .replace(/^(?:(?:remediation(?:\s+\d+)?|bugfix)\s*:\s*)+/i, '')
    .split(' ')
    .map((word) => word.includes('/') ? word : word.toLowerCase())
    .join(' ');
}

function setKey(values: string[]): string {
  return JSON.stringify(Array.from(new Set(values)).sort());
}

function textSetKey(values: string[]): string {
  return setKey(values.map(normalizeText));
}

function claimsKey(item: BacklogItem): string {
  const contract = resolveAcceptanceContract(
    item.acceptance,
    item.acceptance_contract,
  );
  // Ignore generated criterion ids and ordering, not executable obligations.
  // Equal prose with declared claims for different routes is distinct work.
  return setKey(contract.criteria.map((criterion) => JSON.stringify([
    normalizeText(criterion.text),
    setKey(criterion.all_of.map((claim) => JSON.stringify(
      Object.entries(claim)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ))),
  ])));
}

function hasDifferentDeclaredScope(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  return !!left?.length && !!right?.length &&
    textSetKey(left) !== textSetKey(right);
}

/**
 * Conservative creation guard, not fuzzy search or a remediation ban. Require
 * both the same named task and the complete nonempty acceptance set; shared
 * build/test commands alone never establish identity. Explicitly different
 * file scope, constraints or executable claims keep remediation distinct.
 * Lifecycle fields, tier and phase do not give the same work a fresh identity.
 */
export function findEquivalentBacklogItem(
  items: BacklogItem[],
  candidate: BacklogItem,
): BacklogItem | undefined {
  const title = normalizedTitle(candidate.title);
  if (!title || !candidate.acceptance.some((text) => normalizeText(text))) {
    return undefined;
  }
  const acceptance = textSetKey(candidate.acceptance);
  const claims = isDeclaredAcceptanceContract(candidate.acceptance_contract)
    ? claimsKey(candidate)
    : undefined;
  return items.find((item) =>
    normalizedTitle(item.title) === title &&
    textSetKey(item.acceptance) === acceptance &&
    !hasDifferentDeclaredScope(item.touches, candidate.touches) &&
    !hasDifferentDeclaredScope(item.constraints, candidate.constraints) &&
    // Legacy/missing contracts are inferred, not an explicit scope difference.
    // Only two declared contracts can distinguish equal title/acceptance text.
    (claims === undefined ||
      !isDeclaredAcceptanceContract(item.acceptance_contract) ||
      claimsKey(item) === claims),
  );
}