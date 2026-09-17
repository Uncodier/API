import {
  routeFromAppFile,
  summarizeInteractionFindings,
  type InteractionFinding,
  type InteractionSignal,
} from './step-interaction-audit';
import { v5 as uuidv5 } from 'uuid';
import {
  type RequirementScopePolicy,
} from '@/lib/services/requirement-scope-policy';

const routeMarker = (target: string) => `[interaction-route:${target}]`;
const resolutionMarker = (resolution: 'implement' | 'remove') =>
  `[interaction-resolution:${resolution}]`;

/**
 * Missing internal routes become deterministic backlog work immediately.
 * Strict requirements remove out-of-contract navigation; flexible
 * requirements implement the missing destination. Either way, the finding is
 * deferred to the new item so it cannot consume the current step's retries.
 */
export async function applyInteractionBacklogPolicy(params: {
  requirementId: string;
  backlogItemId?: string | null;
  signal: InteractionSignal;
}): Promise<InteractionSignal> {
  if (!params.signal.findings.some(isBacklogCandidate)) return params.signal;

  const {
    isItemTerminal,
    listBacklog,
    upsertBacklogItem,
  } = await import('@/lib/services/requirement-backlog');
  const backlog = await listBacklog(params.requirementId);
  const currentItem =
    backlog.backlog.items.find((item) => item.id === params.backlogItemId) ||
    backlog.backlog.items.find((item) => item.status === 'in_progress') ||
    null;
  const currentItemId = currentItem?.id;
  const routeItems = new Map<
    string,
    import('@/lib/services/requirement-backlog-types').BacklogItem
  >();
  const registerRouteOwner = (
    route: string,
    item: import('@/lib/services/requirement-backlog-types').BacklogItem,
  ) => {
    const existing = routeItems.get(route);
    if (existing?.id === currentItemId && item.id !== currentItemId) return;
    routeItems.set(route, item);
  };
  for (const item of backlog.backlog.items) {
    if (isItemTerminal(item.status) || item.status === 'rejected') continue;
    for (const touch of item.touches || []) {
      const route = routeFromAppFile(touch);
      if (route) registerRouteOwner(route, item);
    }
    for (const route of Array.from(
      extractContractRoutes((item.acceptance || []).join('\n')),
    )) {
      registerRouteOwner(route, item);
    }
    for (const assumption of item.assumptions || []) {
      const match = assumption.match(/^\[interaction-route:(.+)]$/);
      if (match) registerRouteOwner(match[1], item);
    }
  }

  const groupedFindings = new Map<string, InteractionFinding[]>();
  for (const finding of params.signal.findings) {
    if (!isBacklogCandidate(finding) || !finding.target) continue;
    const group = groupedFindings.get(finding.target) || [];
    group.push(finding);
    groupedFindings.set(finding.target, group);
  }

  const deferredItems = new Map<string, string>();
  for (const [route, routeFindings] of Array.from(groupedFindings.entries())) {
    const existingItem = routeItems.get(route);
    if (existingItem && existingItem.id === currentItemId) {
      continue;
    }

    if (existingItem) {
      if (isRemovalItem(existingItem)) {
        const mergedItem = mergeRemovalItem({
          existingItem,
          requirementId: params.requirementId,
          route,
          findings: routeFindings,
          phaseId: backlog.backlog.current_phase_id,
        });
        if (mergedItem) {
          await upsertBacklogItem({
            requirementId: params.requirementId,
            item: mergedItem,
          });
        }
      }
      deferredItems.set(route, existingItem.id);
      continue;
    }

    const policy = await getScopePolicy(
      params.requirementId,
      currentItem,
      route,
    );
    const backlogItem = policy.strict
      ? removalItem({
          requirementId: params.requirementId,
          route,
          findings: routeFindings,
          phaseId: backlog.backlog.current_phase_id,
          reason: policy.reason,
        })
      : implementationItem({
          requirementId: params.requirementId,
          route,
          finding: routeFindings[0],
          phaseId: backlog.backlog.current_phase_id,
        });
    const persistedItem = await upsertBacklogItem({
      requirementId: params.requirementId,
      item: backlogItem,
    });
    deferredItems.set(route, persistedItem.id);
    routeItems.set(route, persistedItem);
  }

  const findings = params.signal.findings.map((finding) => {
    const backlogItemId = finding.target
      ? deferredItems.get(finding.target)
      : undefined;
    return backlogItemId && isBacklogCandidate(finding)
      ? {
          ...finding,
          disposition: 'deferred' as const,
          backlog_item_id: backlogItemId,
        }
      : finding;
  });
  return summarizeInteractionFindings(findings);
}

function isBacklogCandidate(finding: InteractionFinding): boolean {
  return (
    finding.kind === 'broken_link' &&
    finding.disposition === 'create_backlog' &&
    finding.confidence === 'high' &&
    finding.introduced_by_step
  );
}

function isRemovalItem(
  item: import('@/lib/services/requirement-backlog-types').BacklogItem,
): boolean {
  return (item.assumptions || []).includes(resolutionMarker('remove'));
}

function mergeRemovalItem(params: {
  existingItem: import('@/lib/services/requirement-backlog-types').BacklogItem;
  requirementId: string;
  route: string;
  findings: InteractionFinding[];
  phaseId: string;
}) {
  const proposed = removalItem({
    requirementId: params.requirementId,
    route: params.route,
    findings: params.findings,
    phaseId: params.phaseId,
    reason: 'additional source files reference the same out-of-scope route',
  });
  const touches = Array.from(new Set([
    ...(params.existingItem.touches || []),
    ...proposed.touches,
  ]));
  const acceptance = Array.from(new Set([
    ...(params.existingItem.acceptance || []),
    ...proposed.acceptance,
  ]));
  const assumptions = Array.from(new Set([
    ...(params.existingItem.assumptions || []),
    ...proposed.assumptions,
  ]));
  if (
    touches.length === (params.existingItem.touches || []).length &&
    acceptance.length === params.existingItem.acceptance.length &&
    assumptions.length === (params.existingItem.assumptions || []).length
  ) {
    return null;
  }
  return {
    ...params.existingItem,
    touches,
    acceptance,
    assumptions,
  };
}

async function getScopePolicy(
  requirementId: string,
  item: import('@/lib/services/requirement-backlog-types').BacklogItem | null,
  target: string,
): Promise<RequirementScopePolicy> {
  const contract = [
    ...(item?.acceptance || []),
    ...(item?.constraints || []),
    ...(item?.touches || []),
  ].join('\n');
  if (extractContractRoutes(contract).has(target)) {
    return {
      strict: false,
      reason: `route ${target} is explicitly required by the active item`,
    };
  }
  const { resolveRequirementScopePolicy } = await import(
    '@/lib/services/requirement-scope-policy'
  );
  return resolveRequirementScopePolicy(requirementId, item);
}

function extractContractRoutes(contract: string): Set<string> {
  const routes = new Set<string>();
  const routePattern =
    /(?:^|[\s"'`(])(\/(?!\/)[a-z0-9_[\]().-]*(?:\/[a-z0-9_[\]().-]+)*)/gi;
  for (const match of Array.from(contract.matchAll(routePattern))) {
    routes.add(match[1]);
  }
  return routes;
}

function implementationItem(params: {
  requirementId: string;
  route: string;
  finding: InteractionFinding;
  phaseId: string;
}) {
  const pageFile = `src/app${params.route === '/' ? '' : params.route}/page.tsx`;
  const sourceLabel = params.finding.file.split('/').pop() || 'source component';
  return {
    id: uuidv5(
      `interaction-missing-screen:${params.requirementId}:${params.route}`,
      uuidv5.URL,
    ),
    title: `Implement missing ${params.route} screen`,
    kind: 'page' as const,
    phase_id: params.phaseId,
    tier: 'core' as const,
    status: 'pending' as const,
    touches: [pageFile],
    acceptance: [
      `Route ${params.route} renders successfully without a soft 404 or application error.`,
      `${sourceLabel} navigation to ${params.route} renders the destination screen.`,
    ],
    assumptions: [
      routeMarker(params.route),
      resolutionMarker('implement'),
      `Detected from ${params.finding.file}:${params.finding.line}`,
    ],
  };
}

function removalItem(params: {
  requirementId: string;
  route: string;
  findings: InteractionFinding[];
  phaseId: string;
  reason: string;
}) {
  const sourceFiles = Array.from(
    new Set(params.findings.map((finding) => finding.file)),
  );
  const destinationLabel =
    params.route.split('/').filter(Boolean).join(' > ') || 'home';
  return {
    id: uuidv5(
      `interaction-remove-navigation:${params.requirementId}:${params.route}`,
      uuidv5.URL,
    ),
    title: `Remove out-of-scope ${params.route} navigation`,
    kind: 'component' as const,
    phase_id: params.phaseId,
    tier: 'core' as const,
    status: 'pending' as const,
    touches: sourceFiles,
    acceptance: [
      ...sourceFiles.map(
        (file) =>
          `${file.split('/').pop() || 'Source component'} updates navigation so destination "${destinationLabel}" is no longer interactive.`,
      ),
      `Navigation rejects attempts to reach the unimplemented destination "${destinationLabel}" from the current site.`,
    ],
    assumptions: [
      routeMarker(params.route),
      resolutionMarker('remove'),
      `Scope decision: ${params.reason}`,
      ...params.findings.map(
        (finding) => `Detected from ${finding.file}:${finding.line}`,
      ),
    ],
  };
}
