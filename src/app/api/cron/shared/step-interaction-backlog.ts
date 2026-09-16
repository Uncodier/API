import {
  routeFromAppFile,
  summarizeInteractionFindings,
  type InteractionFinding,
  type InteractionSignal,
} from './step-interaction-audit';
import { v5 as uuidv5 } from 'uuid';

const repairMarker = (fingerprints: Iterable<string>) =>
  `[interaction-audit:${Array.from(fingerprints).sort().join(',')}]`;
const routeMarker = (target: string) => `[interaction-route:${target}]`;

/**
 * Gives the producer one complete repair cycle. If the exact missing-page
 * finding survives the next gate, create one deduplicated page backlog item
 * and defer that finding so the current step cannot loop indefinitely.
 */
export async function applyInteractionBacklogPolicy(params: {
  requirementId: string;
  backlogItemId?: string | null;
  signal: InteractionSignal;
}): Promise<InteractionSignal> {
  if (!params.backlogItemId) return params.signal;
  const {
    getBacklogItem,
    isItemTerminal,
    listBacklog,
    logAssumption,
    upsertBacklogItem,
  } = await import('@/lib/services/requirement-backlog');
  const current = await getBacklogItem(params.requirementId, params.backlogItemId);
  if (!current.item) return params.signal;

  const previousFingerprints = new Set<string>();
  for (const assumption of current.item.assumptions || []) {
    const match = assumption.match(/^\[interaction-audit:([a-z0-9,]+)]$/);
    for (const fingerprint of match?.[1].split(',') || []) {
      if (fingerprint) previousFingerprints.add(fingerprint);
    }
  }
  const recordedThisRun = new Set<string>();
  const backlog = await listBacklog(params.requirementId);
  const routeItems = new Map<string, string>();
  for (const item of backlog.backlog.items) {
    if (isItemTerminal(item.status) || item.status === 'rejected') continue;
    for (const touch of item.touches || []) {
      const route = routeFromAppFile(touch);
      if (route) routeItems.set(route, item.id);
    }
    for (const assumption of item.assumptions || []) {
      const match = assumption.match(/^\[interaction-route:(.+)]$/);
      if (match) routeItems.set(match[1], item.id);
    }
  }

  const findings: InteractionFinding[] = [];
  for (const finding of params.signal.findings) {
    if (
      finding.kind !== 'broken_link' ||
      finding.disposition !== 'create_backlog' ||
      finding.confidence !== 'high' ||
      !finding.introduced_by_step
    ) {
      findings.push(finding);
      continue;
    }

    let backlogItemId = finding.target ? routeItems.get(finding.target) : undefined;
    if (backlogItemId === params.backlogItemId) {
      findings.push(finding);
      continue;
    }
    if (!backlogItemId && previousFingerprints.has(finding.fingerprint) && finding.target) {
      const route = finding.target;
      const pageFile = `src/app${route === '/' ? '' : route}/page.tsx`;
      const item = await upsertBacklogItem({
        requirementId: params.requirementId,
        item: {
          id: uuidv5(
            `interaction-missing-screen:${params.requirementId}:${route}`,
            uuidv5.URL,
          ),
          title: `Implement missing ${route} screen`,
          kind: 'page',
          phase_id: backlog.backlog.current_phase_id,
          tier: 'core',
          status: 'pending',
          touches: [pageFile],
          acceptance: [
            `Route ${route} renders successfully without a soft 404 or application error.`,
            `Navigation from ${finding.file} to ${route} renders the destination screen.`,
          ],
          assumptions: [routeMarker(route), `Detected from ${finding.file}:${finding.line}`],
        },
      });
      backlogItemId = item.id;
      routeItems.set(route, item.id);
    }

    if (backlogItemId) {
      findings.push({ ...finding, disposition: 'deferred', backlog_item_id: backlogItemId });
      continue;
    }

    if (!previousFingerprints.has(finding.fingerprint)) recordedThisRun.add(finding.fingerprint);
    findings.push(finding);
  }
  if (recordedThisRun.size > 0) {
    await logAssumption({
      requirementId: params.requirementId,
      itemId: params.backlogItemId,
      assumption: repairMarker(recordedThisRun),
    });
  }
  return summarizeInteractionFindings(findings);
}
