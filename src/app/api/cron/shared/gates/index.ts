/**
 * Per-flow gate dispatcher. Every flow — including `app`/`site` — enters the
 * harness through this single entry point. Heavy build+runtime+deploy logic
 * for the app/site flows lives in `gate-app.ts`, which adapts the canonical
 * `runBuildAndOriginGate` to the unified `FlowGateResult` shape.
 *
 * Vitrinas: when a flow declares `showcase.mode === 'vitrina-build-runtime'`
 * in the registry, the dispatcher will (TODO) wrap the light gate with a
 * build+runtime probe inside the showcase template (e.g. docs viewer, slides
 * viewer, contract renderer). Today the dispatcher ignores the showcase
 * config and runs the light gate — the hook is in place so vitrinas can be
 * introduced without touching every call site.
 */
import { runDocGate } from './gate-doc';
import { runContractGate } from './gate-contract';
import { runSlidesGate } from './gate-slides';
import { runTaskGate } from './gate-task';
import { runBackendGate } from './gate-backend';
import { runAppGate } from './gate-app';
import { getFlow } from '@/lib/services/requirement-flows';
import type { FlowGateInput, FlowGateResult } from './types';
import type { RequirementKind } from '@/lib/services/requirement-flows';

export type { FlowGateInput, FlowGateResult, FlowGateSignal, AppGateContext, AppRichSignals, VercelDeployInfo } from './types';

const REGISTRY: Record<RequirementKind, (input: FlowGateInput) => Promise<FlowGateResult>> = {
  app: runAppGate,
  site: runAppGate,
  doc: runDocGate,
  presentation: runSlidesGate,
  contract: runContractGate,
  automation: runBackendGate,
  task: runTaskGate,
  makinari: runTaskGate,
};

/**
 * Per-flow gate dispatcher. The executor always goes through this function —
 * there are no other entry points for gate execution. Unknown `flow` values
 * fall back to the task gate (lightest, deterministic, no external deps).
 */
export async function runGateForFlow(input: FlowGateInput): Promise<FlowGateResult> {
  const flowDef = getFlow(input.flow);
  // Vitrina hook: `showcase.mode === 'vitrina-build-runtime'` means the
  // deliverable is meant to be visualised in a companion template repo. Once
  // implemented, the gate would clone the template, pipe the artefacts in,
  // run build + runtime probes, and fold the result into the light signals.
  // For now we only log the intent so downstream reporting can surface it.
  if (flowDef?.showcase?.mode === 'vitrina-build-runtime') {
    console.log(
      `[runGateForFlow] showcase=${flowDef.showcase.templateRepo ?? 'n/a'} viewer=${flowDef.showcase.viewerKind ?? 'n/a'} — vitrina build+runtime not yet implemented, running light gate.`,
    );
  }
  const fn = REGISTRY[input.flow] ?? runTaskGate;
  return fn(input);
}
