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
import type { AssistantContext } from '@/app/api/robots/instance/assistant/steps';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import type { GitRepoKind } from '../cron-commit-helpers';
import type {
  ApiSignal,
  BuildSignal,
  ConsoleSignal,
  DeploySignal,
  RuntimeSignal,
  ScenarioSignal,
  VisualSignal,
} from '../step-iteration-signals';

/** Extras the heavy `app`/`site` gate needs (build + runtime + deploy + origin push). */
export interface AppGateContext {
  planTitle: string;
  stepOrder: number;
  stepPrompt: string;
  stepContext?: {
    title?: string;
    instructions?: string;
    expected_output?: string;
    brand_context?: string;
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
  /** Required when `flow` is `app` or `site`; ignored by other gates. */
  appContext?: AppGateContext;
  /** Shared audit context for cron infra logs. */
  audit?: CronAuditContext;
}

export interface FlowGateSignal {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Rich signals the app/site gate returns (build+runtime+visual+deploy+origin). */
export interface AppRichSignals {
  build?: BuildSignal;
  runtime?: RuntimeSignal;
  api?: ApiSignal;
  console?: ConsoleSignal;
  visual?: VisualSignal;
  scenarios?: ScenarioSignal;
  origin?: { ok: boolean; branch?: string; error?: string };
  deploy?: DeploySignal;
}

export interface VercelDeployInfo {
  previewUrl: string | null;
  deployState: string;
  detail?: string;
  buildLogExcerpt?: string | null;
}

export interface FlowGateResult {
  ok: boolean;
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
}
