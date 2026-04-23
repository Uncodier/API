/**
 * Classifies commit/push failures for operator logs vs what the executor agent
 * can reasonably act on in the sandbox.
 */

export type GitPushFailureKind =
  | 'non_fast_forward'
  | 'rebase_conflict'
  | 'rebase_ops_only'
  | 'protected_branch'
  | 'auth'
  | 'server_hook'
  | 'network'
  | 'attach_index'
  | 'invalid_ref'
  | 'vercel_layout'
  | 'unknown';

export type GitPushTriage = {
  failureKind: GitPushFailureKind;
  /** When false, do not run push-recovery tool loops; surface short ops text only. */
  agentActionable: boolean;
  /** Text for the executor retry / ORIGIN block (short, English). */
  agentMessage: string;
  /** Full diagnostic for instance_logs and operators. */
  operatorMessage: string;
};

const OPS_ONLY_MESSAGE =
  'Push failed for repository, credentials, or network reasons. The sandbox cannot fix this; escalate to ops.';

const ATTACH_INDEX_HINT =
  'Git index is blocked (merge/rebase in progress or unresolved conflicts). Run `git status`, then `git merge --abort` or `git rebase --abort` as appropriate, or resolve conflicts, then try again.';

const INVALID_REF_HINT =
  'Branch/HEAD is in an invalid state for push. Create or check out the feature branch, then commit and push.';

/** Git often prints "Rebasing (1/n)"; that string does *not* include the substring "rebase". */
function messageMentionsRebase(s: string): boolean {
  return s.includes('rebase') || s.includes('rebasing') || s.includes('re-apply');
}

export function classifyGitPushFailureMessage(stderr: string): string | null {
  if (!stderr) return null;
  const s = stderr.toLowerCase();
  if (s.includes('resolve your current index first')) {
    return 'attach_index';
  }
  if (s.includes('not a full refname') || s.includes("failed to push branch head")) {
    return 'invalid_ref';
  }
  if (s.includes('[vercel]') || s.includes('vercel/npm layout')) {
    return 'vercel_layout';
  }
  if (s.includes('[rejected]') || s.includes('non-fast-forward') || s.includes('fetch first')) {
    return 'non_fast_forward';
  }
  if (s.includes('protected branch') || s.includes('gh013') || s.includes('push declined')) {
    return 'protected_branch';
  }
  if (
    s.includes('authentication failed') ||
    s.includes('invalid credentials') ||
    s.includes('permission denied') ||
    s.includes('could not read username') ||
    /\b403\b/.test(s) ||
    (s.includes('permission') && s.includes('remote'))
  ) {
    return 'auth';
  }
  if (s.includes('pre-receive hook') || s.includes('hook declined')) {
    return 'server_hook';
  }
  if (messageMentionsRebase(s) && (s.includes('conflict') || s.includes('could not apply'))) {
    return 'rebase_conflict';
  }
  if (s.includes('could not resolve host') || s.includes('network') || s.includes('connection reset')) {
    return 'network';
  }
  if (messageMentionsRebase(s) && s.includes('manual resolution')) {
    return 'rebase_ops_only';
  }
  return null;
}

export function extractConflictFiles(message: string): string[] {
  const out: string[] = [];
  const lines = String(message).split('\n');
  for (var j = 0; j < lines.length; j += 1) {
    const t = String(lines[j]).trim();
    if (t.indexOf('CONFLICT (') !== 0) continue;
    const endType = t.indexOf('):');
    if (endType < 0) continue;
    let rest = t.slice(endType + 2).trim();
    if (!rest) continue;
    const rlow = rest.toLowerCase();
    const mergeIn = 'merge conflict in ';
    if (rlow.startsWith(mergeIn)) {
      rest = rest.slice(mergeIn.length).trim();
    }
    if (rest) out.push(rest);
  }
  return Array.from(new Set(out));
}

/**
 * Triage a full error message (thrown from commitAndPush / commitWorkspace).
 */
export function triageGitPushError(fullMessage: string): GitPushTriage {
  const operatorMessage = String(fullMessage).slice(0, 8000);
  const s = fullMessage.toLowerCase();
  const kindRaw = classifyGitPushFailureMessage(fullMessage);

  if (kindRaw === 'attach_index') {
    return {
      failureKind: 'attach_index',
      agentActionable: true,
      agentMessage: ATTACH_INDEX_HINT,
      operatorMessage,
    };
  }
  if (kindRaw === 'invalid_ref') {
    return {
      failureKind: 'invalid_ref',
      agentActionable: true,
      agentMessage: INVALID_REF_HINT,
      operatorMessage,
    };
  }
  if (kindRaw === 'vercel_layout') {
    return {
      failureKind: 'vercel_layout',
      agentActionable: true,
      agentMessage: fullMessage.replace(/^\[vercel\]\s*/i, 'Layout: ').slice(0, 500),
      operatorMessage,
    };
  }
  if (kindRaw === 'auth' || kindRaw === 'protected_branch') {
    return {
      failureKind: kindRaw,
      agentActionable: false,
      agentMessage: OPS_ONLY_MESSAGE,
      operatorMessage,
    };
  }
  if (kindRaw === 'server_hook') {
    return {
      failureKind: 'server_hook',
      agentActionable: false,
      agentMessage: `${OPS_ONLY_MESSAGE} (server hook)`,
      operatorMessage,
    };
  }
  if (kindRaw === 'network') {
    return {
      failureKind: 'network',
      agentActionable: false,
      agentMessage: 'Network error talking to the git remote. Retry later or check connectivity; the agent cannot fix network policy.',
      operatorMessage,
    };
  }
  if (kindRaw === 'rebase_conflict' || (messageMentionsRebase(s) && s.includes('conflict'))) {
    const files = extractConflictFiles(fullMessage);
    const short = files.length
      ? `Rebase/merge stopped on conflict in: ${files.slice(0, 8).join(', ')}${files.length > 8 ? '…' : ''}. Resolve conflicts, then continue rebase/merge and push, or align with origin (fetch + rebase/merge) before checkpointing.`
      : 'Rebase/merge failed with conflicts. Resolve in the working tree, then continue the rebase/merge and push.';
    return {
      failureKind: 'rebase_conflict',
      agentActionable: true,
      agentMessage: short,
      operatorMessage,
    };
  }
  if (kindRaw === 'rebase_ops_only' || s.includes('manual resolution required')) {
    if (s.includes('non-ground-truth') || s.includes('not auto-fixable') || s.includes('rebase stopped on non-ground-truth')) {
      return {
        failureKind: 'rebase_ops_only',
        agentActionable: true,
        agentMessage:
          'Rebase has conflicts in source code files. Resolve them locally (not only progress/ground-truth), then add, rebase --continue, and push.',
        operatorMessage,
      };
    }
    return {
      failureKind: 'rebase_ops_only',
      agentActionable: true,
      agentMessage:
        'Push was rejected; automatic rebase could not be completed. Resolve git conflicts (see operator log for details), then push again.',
      operatorMessage,
    };
  }
  if (kindRaw === 'non_fast_forward' || s.includes('failed to push')) {
    return {
      failureKind: 'non_fast_forward',
      agentActionable: true,
      agentMessage:
        'Remote advanced the branch. Fetch/rebase (or merge) with origin, resolve any conflicts, then push again. Prefer a single feature branch; avoid many diverging checkpoints on the same file.',
      operatorMessage,
    };
  }
  if (s.includes('refusing to push') && s.includes('head')) {
    return {
      failureKind: 'invalid_ref',
      agentActionable: true,
      agentMessage: INVALID_REF_HINT,
      operatorMessage,
    };
  }
  if (s.includes('refusing to push')) {
    return {
      failureKind: 'unknown',
      agentActionable: true,
      agentMessage: 'Push was refused. Check git output in logs; create/check out a valid feature branch and try again.',
      operatorMessage,
    };
  }
  return {
    failureKind: 'unknown',
    agentActionable: true,
    agentMessage: 'Commit/push failed. See the operator log for the full git error.',
    operatorMessage,
  };
}

export class CommitPushTriageError extends Error {
  readonly triage: GitPushTriage;
  constructor(triage: GitPushTriage, options?: { cause?: unknown }) {
    super(triage.operatorMessage, options);
    this.name = 'CommitPushTriageError';
    this.triage = triage;
  }
}

export function isCommitPushTriageError(e: unknown): e is CommitPushTriageError {
  return e instanceof CommitPushTriageError;
}

/**
 * @deprecated Use triageGitPushError. Kept for backward compatibility with imports.
 */
export function classifyGitPushFailure(stderr: string): string | null {
  return classifyGitPushFailureMessage(stderr);
}
