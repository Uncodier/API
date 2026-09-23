import type {
  InteractionFinding,
  InteractionSignal,
} from './step-interaction-audit';

export function summarizeInteractionFindings(
  findings: InteractionFinding[],
): InteractionSignal {
  const blocking = findings.filter(
    (finding) =>
      finding.introduced_by_step &&
      finding.confidence === 'high' &&
      finding.disposition !== 'deferred',
  );
  const deferred = findings.filter(
    (finding) => finding.disposition === 'deferred',
  );
  const warnings = findings.filter(
    (finding) => !blocking.includes(finding) && !deferred.includes(finding),
  );
  const remediationItemIds = Array.from(new Set(
    deferred
      .map((finding) => finding.backlog_item_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  ));
  return {
    ok: blocking.length === 0 && deferred.length === 0,
    findings,
    blocking_count: blocking.length,
    deferred_count: deferred.length,
    warning_count: warnings.length,
    remediation_required: deferred.length > 0,
    remediation_item_ids: remediationItemIds,
    summary:
      `${blocking.length} blocking, ${deferred.length} scheduled remediation, ` +
      `${warnings.length} warning interaction finding(s)`,
  };
}

export function formatInteractionFailure(signal: InteractionSignal): string {
  const lines = signal.findings
    .filter(
      (finding) =>
        finding.disposition === 'deferred' ||
        finding.introduced_by_step,
    )
    .slice(0, 20)
    .map((finding) => {
      const target = finding.target ? ` target=${finding.target}` : '';
      const backlog = finding.backlog_item_id
        ? ` remediation=${finding.backlog_item_id}`
        : '';
      return `- ${finding.file}:${finding.line} [${finding.kind}/${finding.confidence}] ${finding.reason}${target}${backlog}`;
    });
  if (signal.remediation_required) {
    const handoff = signal.active_item_suspended
      ? 'The active item is suspended until the remediation backlog item passes its own gates.'
      : 'Remediation backlog work was scheduled, while the active item remains responsible for its other blocking findings.';
    return [
      `Interaction remediation scheduled: ${signal.summary}.`,
      ...lines,
      handoff,
    ].join('\n');
  }
  return [
    `Interaction audit failed: ${signal.summary}.`,
    ...lines,
    'Repair these local defects in this cycle. Implement a missing route only when the active item contract requires it; otherwise remove the invalid navigation.',
    'Out-of-contract missing routes are handled as deduplicated backlog work and must not expand this item.',
  ].join('\n');
}
