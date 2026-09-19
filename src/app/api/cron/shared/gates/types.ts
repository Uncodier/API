/**
 * Common types for the per-flow gates.
 *
 * Each gate produces a `FlowGateResult` with:
 *   - ok: did the deliverable pass the flow's hard rules?
 *   - signals: typed signals consumed by Critic / Judge / loop-detectors.
 *   - reason: short human-readable summary used in cron audit logs.
 *
 * Heavy flows (app / site) also return rich signals (build/runtime/visual/
 * scenarios/origin/deploy) and the updated assistant `lastResult` so the
 * executor can feed retries and the archetype post-gate.
 *
 * Vitrinas (showcase repos with viewers per deliverable kind) are declared
 * per flow in `FlowDefinition.showcase`; when present, a vitrina-aware gate
 * can wrap the light gate with a build+runtime probe using the showcase
 * template. This hook is materialised in the dispatcher so gates remain
 * deliverable-focused and vitrina handling stays in one place.
 */
import type { Sandbox } from '@vercel/sandbox';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import type { AssistantContext } from '@/app/api/robots/instance/assistant/types';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import type { GitRepoKind } from '../cron-commit-helpers';
import type {
  ApiSignal,
  BuildSignal,
  ConsoleSignal,
  DeploySignal,
  InteractionSignal,
  OriginSignal,
  RuntimeSignal,
  ScenarioSignal,
  VisualSignal,
} from '../step-iteration-signals';
import type { TestSignal } from '../step-test-evidence';
import type {
  ProbeDisposition,
  ProbeObservation,
} from '../step-probe-policy';

/** Extras the heavy `app`/`site` gate needs (build + runtime + deploy + origin push). */
export interface AppGateContext {
  planTitle: string;
  stepOrder: number;
  backlogItemId?: string | null;
  interactionBaselineSha?: string | null;
  stepPrompt: string;
  stepContext?: {
    title?: string;
    instructions?: string;
    expected_output?: string;
    brand_context?: string;
    protected_routes?: string[];
    validation_targets?: unknown;
    test_command?: string;
  };
  currentMessages: any[];
  assistantContext: AssistantContext;
  fullTools: any[];
  lastResult: any;
  gitRepoKind?: GitRepoKind;
}

export interface FlowGateInput {
  sandbox: Sandbox;
  workDir: string;
  requirementId: string;
  flow: RequirementKind;
  item?: BacklogItem | null;
  /** Optional: file paths in the workspace the gate should focus on. */
  artifacts?: string[];
  /** Rich app context, also used by automation gates for origin persistence. */
  appContext?: AppGateContext;
  /** Shared audit context for cron infra logs. */
  audit?: CronAuditContext;
}

export interface FlowGateSignal {
  name: string;
  ok: boolean;
  detail?: string;
  disposition?: ProbeDisposition;
}

/** Rich signals the app/site gate returns (build+runtime+visual+deploy+origin). */
export interface AppRichSignals {
  build?: BuildSignal;
  interaction?: InteractionSignal;
  runtime?: RuntimeSignal;
  api?: ApiSignal;
  console?: ConsoleSignal;
  visual?: VisualSignal;
  scenarios?: ScenarioSignal;
  origin?: OriginSignal;
  deploy?: DeploySignal;
  tests?: TestSignal;
  observations?: ProbeObservation[];
}

export interface VercelDeployInfo {
  previewUrl: string | null;
  deployState: string;
  detail?: string;
  commitSha?: string;
  branch?: string;
  deploymentId?: string | null;
  gitRepoKind?: GitRepoKind;
  buildLogExcerpt?: string | null;
}

export interface FlowGateResult {
  ok: boolean;
  disposition?: 'pass' | 'hard_fail' | 'unknown' | 'advisory';
  flow: RequirementKind;
  signals: FlowGateSignal[];
  reason?: string;
  error?: string;
  /** Populated by heavy gates (app/site / vitrina build-runtime). */
  richSignals?: AppRichSignals;
  /** Populated by the app/site gate when push recovery ran. */
  lastResult?: any;
  /** Populated by the app/site gate after the Vercel deploy poll. */
  vercelDeploy?: VercelDeployInfo;
  /**
   * True when the Vercel microVM stopped mid-gate (410 Gone, etc.). Caller
   * should reprovision and retry the step — not treat as a code failure.
   */
  sandboxUnavailable?: boolean;
  /**
   * A planned gate could not run because its supporting infrastructure failed.
   * Callers should retry without charging the product step retry budget.
   */
  infrastructureFailure?: boolean;
  /**
   * When the gate replaces the sandbox (e.g. after taking a snapshot), it
   * returns the new Sandbox instance here so the caller can use it.
   */
  sandboxReplacement?: Sandbox;
  /**
   * Constraint hit was on a pre-existing line (not in this-step diff).
   * Callers must not bump backlog attempts.
   */
  skipAttemptBump?: boolean;
  /**
   * The gate created mandatory backlog work and suspended the active item
   * behind it. This is orchestration progress, not a product failure.
   */
  remediationScheduled?: boolean;
}
