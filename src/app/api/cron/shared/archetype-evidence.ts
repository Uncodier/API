import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';

export interface ToolCallSummary {
  name: string;
  ok: boolean;
  text?: string;
}

export function toolCalls(evidence: EvidenceRecord): ToolCallSummary[] {
  const out: ToolCallSummary[] = [];
  if (evidence.build) {
    out.push({
      name: evidence.build.command || 'npm run build',
      ok: evidence.build.exit_code === 0,
      text: `exit_code=${evidence.build.exit_code} duration_ms=${evidence.build.duration_ms}`,
    });
  }
  for (const test of evidence.tests ?? []) {
    out.push({
      name: test.command,
      ok: test.exit_code === 0 && test.ran_after_changes,
      text: test.output_tail,
    });
  }
  if (evidence.runtime) {
    out.push({
      name: `curl ${evidence.runtime.route}`,
      ok:
        evidence.runtime.http_status >= 200 &&
        evidence.runtime.http_status < 400,
      text: `status=${evidence.runtime.http_status}`,
    });
  }
  for (const scenario of evidence.scenarios ?? []) {
    out.push({
      name: `scenario:${scenario.name}`,
      ok: scenario.pass,
      text: `duration_ms=${scenario.duration_ms}`,
    });
  }
  for (const observation of evidence.observations ?? []) {
    if (
      !observation.target ||
      (observation.kind !== 'api' && observation.kind !== 'page')
    ) {
      continue;
    }
    out.push({
      name: `curl ${observation.target}`,
      ok: observation.disposition === 'pass',
      text: observation.detail,
    });
  }
  return out;
}

export function hasToolCall(
  evidence: EvidenceRecord,
  predicate: (call: ToolCallSummary) => boolean,
): boolean {
  return toolCalls(evidence).some(predicate);
}

export function gateSignals(evidence: EvidenceRecord): {
  build?: { ok: boolean; detail?: string };
  runtime?: { ok: boolean; detail?: string };
  scenarios?: { ok: boolean; detail?: string };
} {
  const out: {
    build?: { ok: boolean; detail?: string };
    runtime?: { ok: boolean; detail?: string };
    scenarios?: { ok: boolean; detail?: string };
  } = {};

  if (evidence.build) {
    const ok = evidence.build.exit_code === 0;
    out.build = {
      ok,
      detail: !ok
        ? `command="${evidence.build.command}" exit_code=${evidence.build.exit_code}`
        : undefined,
    };
  }
  if (evidence.runtime) {
    const ok =
      evidence.runtime.http_status >= 200 &&
      evidence.runtime.http_status < 400;
    out.runtime = {
      ok,
      detail: !ok
        ? `route="${evidence.runtime.route}" http_status=${evidence.runtime.http_status}`
        : undefined,
    };
  }
  if (evidence.scenarios?.length) {
    const failed = evidence.scenarios
      .filter((scenario) => !scenario.pass)
      .map((scenario) => scenario.name);
    const ok = failed.length === 0;
    out.scenarios = {
      ok,
      detail: !ok
        ? `failed=[${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '...' : ''}]`
        : undefined,
    };
  }
  return out;
}

export function commitSummary(
  evidence: EvidenceRecord,
): { sha?: string; files: string[] } {
  return { sha: evidence.commit_sha, files: evidence.changed_files ?? [] };
}

export function isAdminOnlyDiff(files: string[]): boolean {
  if (!files.length) return false;
  return files.every((file) =>
    /\.md$/i.test(file) ||
    /(?:^|\/)__tests__\//i.test(file) ||
    /(?:^|\/)tests?\//i.test(file) ||
    /\.(?:test|spec)\.[^.]+$/i.test(file) ||
    /^evidence\//.test(file) ||
    /^\.qa\//.test(file) ||
    /^(?:qa|test)_results\.json$/i.test(file) ||
    /^progress\.md$/i.test(file) ||
    /^DECISIONS\.md$/i.test(file) ||
    /^README(\.md)?$/i.test(file) ||
    /^feature_list\.json$/i.test(file) ||
    /^requirement\.spec\.md$/i.test(file) ||
    /^\.instructions$/i.test(file)
  );
}

export function isLandingOnlyDiff(files: string[]): boolean {
  if (!files.length) return false;
  const code = files.filter((file) => /^src\//.test(file));
  if (!code.length) return false;
  return code.every((file) =>
    /^src\/app\/page\.(t|j)sx?$/.test(file) ||
    /^src\/app\/layout\.(t|j)sx?$/.test(file) ||
    /^src\/app\/globals\.css$/.test(file) ||
    /^src\/components\//.test(file) ||
    /^src\/styles\//.test(file)
  );
}

export function evidenceClaim(evidence: EvidenceRecord): string {
  const parts: string[] = [];
  if (evidence.judge_reason) parts.push(evidence.judge_reason);
  if (evidence.assumptions_logged?.length) {
    parts.push(evidence.assumptions_logged.join(' | '));
  }
  return parts.join('\n');
}

export function evidenceHaystack(evidence: EvidenceRecord): string[] {
  const calls = toolCalls(evidence)
    .filter((call) => call.ok)
    .map((call) => `${call.name} ${call.text ?? ''}`);
  const signals = JSON.stringify(gateSignals(evidence));
  const commit = JSON.stringify(commitSummary(evidence));
  const artifacts = (evidence.feature_coverage?.artifact_proofs || [])
    .filter(
      (artifact) =>
        artifact.exists && artifact.outcome !== 'not_evaluable',
    )
    .map(
      (artifact) =>
        `file=${artifact.path} exists=true bytes=${artifact.bytes ?? 0} ` +
        `${artifact.content_excerpt || ''}`,
    );
  return [...calls, ...artifacts, signals, commit];
}

export function featureCoverageFailure(
  evidence: EvidenceRecord,
): string | null {
  const coverage = evidence.feature_coverage;
  if (!coverage) return null;

  const failedKinds = (coverage.kind_requirements ?? [])
    .filter(
      (requirement) =>
        !requirement.satisfied &&
        requirement.outcome !== 'not_evaluable',
    );
  if (failedKinds.length > 0) {
    return `feature kind requirements failed: ${failedKinds
      .map((requirement) =>
        `${requirement.requirement}${requirement.detail ? ` (${requirement.detail})` : ''}`)
      .join(', ')}`;
  }

  const missingPageCount = Math.max(
    0,
    (coverage.expected_page_routes?.length ?? 0) -
      (coverage.present_page_files?.length ?? 0) -
      (coverage.not_evaluable_page_routes?.length ?? 0),
  );
  const missingApiCount = Math.max(
    0,
    (coverage.expected_api_routes?.length ?? 0) -
      (coverage.present_api_files?.length ?? 0) -
      (coverage.not_evaluable_api_routes?.length ?? 0),
  );
  const missingTouches = coverage.missing_touches ?? [];
  if (
    missingPageCount === 0 &&
    missingApiCount === 0 &&
    missingTouches.length === 0
  ) {
    return null;
  }

  return [
    missingTouches.length > 0
      ? `missing declared files: ${missingTouches.join(', ')}`
      : null,
    missingPageCount > 0
      ? `missing page routes: ${(coverage.expected_page_routes ?? []).join(', ')}`
      : null,
    missingApiCount > 0
      ? `missing API routes: ${(coverage.expected_api_routes ?? []).join(', ')}`
      : null,
  ].filter(Boolean).join('; ');
}

export function featureCoverageEvidenceGap(
  evidence: EvidenceRecord,
): string | null {
  const coverage = evidence.feature_coverage;
  if (!coverage || coverage.evaluable !== false) return null;
  const targets = [
    ...(coverage.not_evaluable_touches ?? []),
    ...(coverage.not_evaluable_page_routes ?? []),
    ...(coverage.not_evaluable_api_routes ?? []),
    ...(coverage.kind_requirements ?? [])
      .filter((requirement) => requirement.outcome === 'not_evaluable')
      .map((requirement) => requirement.requirement),
  ];
  const detail = (coverage.probe_errors ?? [])
    .slice(0, 3)
    .map((error) => `${error.target}: ${error.detail}`)
    .join('; ');
  return [
    'feature coverage could not be evaluated',
    targets.length > 0 ? `targets=${targets.join(', ')}` : null,
    detail || null,
  ].filter(Boolean).join('; ');
}
