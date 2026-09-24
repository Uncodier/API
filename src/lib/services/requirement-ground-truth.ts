import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { mutateBacklogAtomically } from './requirement-backlog-mutation';
import { patchRequirementMetadataKeys } from './requirement-metadata-patch';
import type { EvidenceRecord } from './requirement-evidence-types';
export type {
  EvidenceRecord,
  FeatureCoverageEvidence,
  InteractionEvidence,
} from './requirement-evidence-types';

/**
 * Ground-truth file helpers.
 *
 * The repository tree is the single source of truth for a requirement's work:
 *   - requirement.spec.md     immutable contract (overview, goals, acceptance).
 *   - feature_list.json       mirror of requirements.backlog.
 *   - progress.md             session-by-session log (append-only).
 *   - DECISIONS.md            architecture + assumption log (append-only).
 *   - evidence/<item_id>.json structured evidence per backlog item.
 *
 * The DB still holds canonical copies (in `requirements.metadata`) but the
 * LLM reads/writes the mirror inside the sandbox via its native file tools.
 * Everything here is idempotent — we never fail a commit because a ground-truth
 * file did not write.
 */

export interface ProgressEntry {
  ts: string;
  cycle?: number;
  phase?: string;
  item_id?: string;
  summary: string;
  next?: string;
  cycles?: number;
}

export interface DecisionEntry {
  ts: string;
  decision: string;
  reason: string;
  item_id?: string;
  author?: string;
}

async function runInSandbox(sandbox: Sandbox, cmd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const res = await sandbox.runCommand({ cmd, args });
  const stdout = (await res.stdout()).toString();
  let stderr = '';
  try {
    stderr = (await res.stderr()).toString();
  } catch {
    /* noop */
  }
  return { exitCode: res.exitCode ?? -1, stdout, stderr };
}

async function writeSandboxFile(sandbox: Sandbox, cwd: string, relPath: string, contents: string): Promise<void> {
  const abs = `${cwd}/${relPath}`;
  const dir = abs.includes('/') ? abs.slice(0, abs.lastIndexOf('/')) : cwd;
  await runInSandbox(sandbox, 'mkdir', ['-p', dir]);
  // Use a tiny base64 envelope so arbitrary content (newlines, quotes, unicode)
  // never breaks the shell invocation.
  const b64 = Buffer.from(contents, 'utf8').toString('base64');
  await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `echo '${b64}' | base64 -d > "${abs}"`],
  });
}

async function readSandboxFile(sandbox: Sandbox, cwd: string, relPath: string): Promise<string | null> {
  const res = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `[ -f "${cwd}/${relPath}" ] && cat "${cwd}/${relPath}" || echo __MISSING__`],
  });
  const out = (await res.stdout()).toString();
  if (out.trim() === '__MISSING__') return null;
  return out;
}

function isoNow(): string {
  return new Date().toISOString();
}

function loadRequirementMetadata(requirementId: string) {
  return supabaseAdmin
    .from('requirements')
    .select('id, title, type, site_id, metadata, backlog, progress')
    .eq('id', requirementId)
    .maybeSingle();
}

export async function writeEvidence(params: {
  sandbox?: Sandbox;
  cwd?: string;
  requirementId: string;
  itemId: string;
  requireCanonicalPersistence?: boolean;
  record: Partial<Omit<EvidenceRecord, 'item_id' | 'schema_version'>> &
    Partial<Pick<EvidenceRecord, 'schema_version'>>;
}): Promise<EvidenceRecord> {
  const incoming: EvidenceRecordInput = {
    ...params.record,
    schema_version: 1,
    item_id: params.itemId,
    captured_at: params.record.captured_at || isoNow(),
  };
  let full = mergeEvidenceRecords(undefined, incoming);

  // Persist in DB backlog item's evidence field (canonical).
  try {
    full = await mutateBacklogAtomically(params.requirementId, ({ backlog }) => {
      const idx = backlog.items.findIndex((item) => item.id === params.itemId);
      if (idx < 0) {
        if (params.requireCanonicalPersistence) {
          throw new Error(
            `Backlog item ${params.itemId} is missing during evidence persistence`,
          );
        }
        return { result: full, write: false };
      }
      const merged = mergeEvidenceRecords(
        backlog.items[idx].evidence,
        incoming,
      );
      backlog.items[idx] = { ...backlog.items[idx], evidence: merged };
      return { result: merged };
    });
  } catch (e: unknown) {
    if (params.requireCanonicalPersistence) {
      throw new Error(
        `Canonical evidence persistence failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    console.warn('[GroundTruth.writeEvidence] DB persist failed:', e instanceof Error ? e.message : e);
  }

  if (params.sandbox && params.cwd) {
    try {
      await writeSandboxFile(
        params.sandbox,
        params.cwd,
        `evidence/${params.itemId}.json`,
        JSON.stringify(full, null, 2),
      );
    } catch (e: unknown) {
      console.warn('[GroundTruth.writeEvidence] Sandbox mirror failed:', e instanceof Error ? e.message : e);
    }
  }

  return full;
}

export function mergeEvidenceRecords(
  existing: EvidenceRecord | undefined,
  incoming: EvidenceRecordInput,
): EvidenceRecord {
  const startsNewEvidenceRun =
    typeof incoming.evidence_run_id === 'string' &&
    incoming.evidence_run_id.length > 0 &&
    incoming.evidence_run_id !== existing?.evidence_run_id;
  const startsLegacyChangeSet =
    !incoming.evidence_run_id &&
    Array.isArray(incoming.changed_files) &&
    incoming.changed_files.length > 0;
  const startsNewWorkspaceFingerprint =
    typeof incoming.workspace_fingerprint === 'string' &&
    incoming.workspace_fingerprint.length > 0 &&
    incoming.workspace_fingerprint !== existing?.workspace_fingerprint;
  const startsNewChangeSet =
    startsNewEvidenceRun ||
    startsLegacyChangeSet ||
    startsNewWorkspaceFingerprint;
  const prior = startsNewChangeSet ? undefined : existing;
  const tests = new Map<string, NonNullable<EvidenceRecord['tests']>[number]>();
  const testCandidates = startsNewChangeSet
    ? incoming.tests || []
    : [...(prior?.tests || []), ...(incoming.tests || [])];
  for (const test of testCandidates) {
    tests.set(
      [
        test.step_id || '',
        test.command,
        test.workspace_fingerprint || test.captured_at || '',
      ].join(':'),
      test,
    );
  }
  const observations = new Map<
    string,
    NonNullable<EvidenceRecord['observations']>[number]
  >();
  const observationCandidates = startsNewChangeSet
    ? incoming.observations || []
    : [...(prior?.observations || []), ...(incoming.observations || [])];
  for (const observation of observationCandidates) {
    observations.set(
      [
        observation.kind,
        observation.disposition,
        observation.source,
        observation.target || '',
        observation.detail,
      ].join(':'),
      observation,
    );
  }
  const assertions = new Map<
    string,
    NonNullable<EvidenceRecord['scenario_assertions']>[number]
  >();
  const assertionCandidates = startsNewChangeSet
    ? incoming.scenario_assertions || []
    : [
        ...(prior?.scenario_assertions || []),
        ...(incoming.scenario_assertions || []),
      ];
  for (const assertion of assertionCandidates) {
    assertions.set(JSON.stringify(assertion), assertion);
  }
  const definedIncoming = Object.fromEntries(
    Object.entries(incoming).filter(([, value]) => value !== undefined),
  ) as EvidenceRecordInput;
  return {
    ...prior,
    ...definedIncoming,
    tests: tests.size ? Array.from(tests.values()).slice(-20) : undefined,
    observations: observations.size
      ? Array.from(observations.values()).slice(-100)
      : undefined,
    scenario_assertions: assertions.size
      ? Array.from(assertions.values()).slice(-100)
      : undefined,
    critic_passes:
      incoming.critic_passes ?? prior?.critic_passes ?? 0,
  };
}

type EvidenceRecordInput =
  Partial<EvidenceRecord> &
  Pick<EvidenceRecord, 'schema_version' | 'item_id' | 'captured_at'>;

export async function syncBacklogToFile(params: {
  sandbox: Sandbox;
  cwd: string;
  requirementId: string;
}): Promise<{ wrote: boolean; items: number }> {
  try {
    const { data: req } = await loadRequirementMetadata(params.requirementId);
    const backlog = req?.backlog as any;
    if (!backlog) return { wrote: false, items: 0 };
    await writeSandboxFile(params.sandbox, params.cwd, 'feature_list.json', JSON.stringify(backlog, null, 2));
    return { wrote: true, items: Array.isArray(backlog.items) ? backlog.items.length : 0 };
  } catch (e: unknown) {
    console.warn('[GroundTruth.syncBacklogToFile] failed:', e instanceof Error ? e.message : e);
    return { wrote: false, items: 0 };
  }
}

export async function syncProgressEntry(params: {
  sandbox: Sandbox;
  cwd: string;
  requirementId: string;
  entry: ProgressEntry;
}): Promise<void> {
  const { entry } = params;

  try {
    const existing = (await readSandboxFile(params.sandbox, params.cwd, 'progress.md')) ?? '# Progress log\n\n';
    const lines = existing.trimEnd().split('\n');
    
    let lastHeaderIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('## ')) {
        lastHeaderIdx = i;
        break;
      }
    }

    let isDuplicate = false;
    let cycleCount = 1;

    if (lastHeaderIdx !== -1) {
      const lastEntryLines = lines.slice(lastHeaderIdx);
      const summaryLine = lastEntryLines.find(l => l.startsWith('- summary: '));
      if (summaryLine && summaryLine === `- summary: ${entry.summary}`) {
        isDuplicate = true;
        const cycleLine = lastEntryLines.find(l => l.startsWith('- cycles: '));
        if (cycleLine) {
          const match = cycleLine.match(/- cycles: (\d+)/);
          if (match) {
            cycleCount = parseInt(match[1], 10) + 1;
          }
        } else {
          cycleCount = 2;
        }
      }
    }

    const newLine = [
      `## ${entry.ts}`,
      entry.cycle != null ? `- cycle: ${entry.cycle}` : null,
      entry.phase ? `- phase: ${entry.phase}` : null,
      entry.item_id ? `- item: ${entry.item_id}` : null,
      `- summary: ${entry.summary}`,
      isDuplicate ? `- cycles: ${cycleCount}` : null,
      entry.next ? `- next: ${entry.next}` : null,
      '',
    ]
      .filter(Boolean)
      .join('\n');

    let updated = existing;
    if (isDuplicate) {
      lines.splice(lastHeaderIdx);
      updated = lines.join('\n') + (lines.length > 0 ? '\n' : '') + newLine;
    } else {
      updated = existing.endsWith('\n') ? existing + newLine : existing + '\n' + newLine;
    }

    await writeSandboxFile(params.sandbox, params.cwd, 'progress.md', updated);
  } catch (e: unknown) {
    console.warn('[GroundTruth.syncProgressEntry] failed:', e instanceof Error ? e.message : e);
  }

  // Shadow the last N entries on the requirement metadata for quick reads.
  try {
    const { data: req } = await loadRequirementMetadata(params.requirementId);
    const log: ProgressEntry[] = Array.isArray(req?.progress) ? req.progress : [];
    
    if (log.length > 0) {
      const lastLog = log[log.length - 1];
      if (lastLog.summary === entry.summary) {
        lastLog.ts = entry.ts;
        lastLog.cycles = (lastLog.cycles || 1) + 1;
      } else {
        log.push(entry);
      }
    } else {
      log.push(entry);
    }
    
    const newProgress = log.slice(-50);
    await supabaseAdmin.from('requirements').update({ progress: newProgress }).eq('id', params.requirementId);
  } catch (e: unknown) {
    console.warn('[GroundTruth.syncProgressEntry] DB shadow failed:', e instanceof Error ? e.message : e);
  }
}

export async function appendDecision(params: {
  sandbox?: Sandbox;
  cwd?: string;
  requirementId: string;
  decision: DecisionEntry;
}): Promise<void> {
  const { decision } = params;
  const line = [
    `## ${decision.ts}`,
    `- decision: ${decision.decision}`,
    `- reason: ${decision.reason}`,
    decision.item_id ? `- item: ${decision.item_id}` : null,
    decision.author ? `- by: ${decision.author}` : null,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  if (params.sandbox && params.cwd) {
    try {
      const existing = (await readSandboxFile(params.sandbox, params.cwd, 'DECISIONS.md')) ?? '# Decisions\n\n';
      const updated = existing.endsWith('\n') ? existing + line : existing + '\n' + line;
      await writeSandboxFile(params.sandbox, params.cwd, 'DECISIONS.md', updated);
    } catch (e: unknown) {
      console.warn('[GroundTruth.appendDecision] sandbox mirror failed:', e instanceof Error ? e.message : e);
    }
  }

  try {
    const { data: req } = await loadRequirementMetadata(params.requirementId);
    const metadata = (req?.metadata ?? {}) as Record<string, any>;
    const log: DecisionEntry[] = Array.isArray(metadata.decisions_log) ? metadata.decisions_log : [];
    log.push(decision);
    await patchRequirementMetadataKeys({
      requirementId: params.requirementId,
      patch: { decisions_log: log.slice(-200) },
    });
  } catch (e: unknown) {
    console.warn('[GroundTruth.appendDecision] DB shadow failed:', e instanceof Error ? e.message : e);
  }
}

export async function readGroundTruth(params: { sandbox: Sandbox; cwd: string }): Promise<{
  spec: string | null;
  features: any | null;
  progress: string | null;
  decisions: string | null;
  agents: string | null;
}> {
  const [spec, features, progress, decisions, agents] = await Promise.all([
    readSandboxFile(params.sandbox, params.cwd, 'requirement.spec.md'),
    readSandboxFile(params.sandbox, params.cwd, 'feature_list.json'),
    readSandboxFile(params.sandbox, params.cwd, 'progress.md'),
    readSandboxFile(params.sandbox, params.cwd, 'DECISIONS.md'),
    readSandboxFile(params.sandbox, params.cwd, 'AGENTS.md'),
  ]);
  let parsedFeatures: any = null;
  if (features) {
    try {
      parsedFeatures = JSON.parse(features);
    } catch {
      /* leave null */
    }
  }
  return { spec, features: parsedFeatures, progress, decisions, agents };
}

/**
 * Called by the commit pipeline right before `git add` — mirrors the canonical
 * backlog + progress to the workspace so every commit includes up-to-date
 * ground-truth files alongside any code changes.
 */
export async function syncGroundTruthBeforeCommit(params: {
  sandbox: Sandbox;
  cwd: string;
  requirementId: string;
  title?: string;
  note?: string;
  appendProgress?: boolean | 'if-workspace-dirty';
}): Promise<void> {
  await syncBacklogToFile({
    sandbox: params.sandbox,
    cwd: params.cwd,
    requirementId: params.requirementId,
  });

  let shouldAppendProgress = params.appendProgress !== false;
  if (params.appendProgress === 'if-workspace-dirty') {
    try {
      const status = await runInSandbox(params.sandbox, 'git', [
        '-C',
        params.cwd,
        'status',
        '--porcelain',
        '--untracked-files=all',
      ]);
      shouldAppendProgress = status.exitCode !== 0 || status.stdout.trim().length > 0;
    } catch {
      shouldAppendProgress = true;
    }
  }

  if (shouldAppendProgress) {
    await syncProgressEntry({
      sandbox: params.sandbox,
      cwd: params.cwd,
      requirementId: params.requirementId,
      entry: {
        ts: isoNow(),
        summary: params.note || `checkpoint: ${params.title || 'commit'}`,
      },
    });
  }
}
