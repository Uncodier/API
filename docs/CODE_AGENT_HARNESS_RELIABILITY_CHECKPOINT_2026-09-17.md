# Code-Agent Harness Reliability Appendix

Status: working-tree checkpoint  
Captured: 2026-09-17  
Parent: [Code-Agent Harness Architecture Checkpoint](./CODE_AGENT_HARNESS_CHECKPOINT_2026-09-17.md)

## Ground-truth model

The sandbox repository exposes agent-readable files:

- `requirement.spec.md`
- `feature_list.json`
- `progress.md`
- `DECISIONS.md`
- `evidence/<item-id>.json`

The database remains canonical for requirement, backlog, plan, and evidence state. Repository files are mirrors used by the agent and delivery pipeline.

## Migration map

- `20260917143000_requirement_backlog_revision.sql`: optimistic backlog revisioning.
- `20260917203000_atomic_cron_cycle_accounting.sql`: durable cycle accounting and atomic metadata operations.
- `20260917203100_atomic_plan_infrastructure_state.sql`: row-locked infrastructure state RPCs and event accounting.
- `20260917203200_atomic_deployment_infrastructure_recovery.sql`: correlated transactional deployment recovery.
- `20260917203300_atomic_infrastructure_block_transition.sql`: atomic infrastructure and accumulated-cycle block transitions.
- `20260917203350_generation_guarded_accumulated_blocks.sql`: execution-generation guards for accumulated blockers.
- `20260917203400_atomic_requirement_block.sql`: generic generation-guarded requirement blocking.
- `20260917203500_atomic_plan_step_patch.sql`: event-idempotent, generation-guarded plan-step patching.
- `20260917203600_atomic_instance_execution_resume.sql`: idempotent user/schedule resume and infrastructure reset.
- `20260917203700_single_active_instance_plan.sql`: duplicate-plan cleanup and one-active-plan partial unique index.
- `20260917203800_deployment_recovery_scan_lease.sql`: owner-safe fallback recovery scan lease.
- `20260917203900_atomic_requirement_finalization.sql`: atomic status, requirement, instance, and plan finalization.
- `20260917204000_terminal_step_infrastructure_cleanup.sql`: infrastructure cleanup on terminal step transitions.

## Resolved at this checkpoint

- The scheduler resolves the repository kind from `metadata.git`, with the
  requirement type as a legacy fallback, and passes it through sandbox,
  orchestrator, executor, Vercel, push, and preview operations.
- Tracking injection, application-schema migrations, tenant provisioning, and
  deployment validation are explicit flow capabilities. Light artifact flows
  skip application-only side effects.
- Automation gates receive origin context and verify that each completed step
  is persisted to the automation repository.

## Known caveats at this checkpoint

1. Repository ground-truth files are mirrors.  
   Evidence, progress, and decision files can temporarily diverge from canonical database state if sandbox writes fail.

2. The deployment scan lease is not renewed.  
   A scan exceeding its TTL could overlap a successor, although owner-checked release prevents the old owner from deleting the replacement lease.

3. The main run lock can degrade open when required database columns or permissions are unavailable.  
   This preserves availability but removes serialization in a misconfigured environment.

4. Maintenance/QA code is currently dormant.  
   Do not assume it runs after the primary workflow.

## Safe modification checklist

Before changing the harness:

1. Identify whether the change affects product retries, infrastructure retries, or both.
2. Preserve event idempotency in durable workflow steps.
3. Pass and validate the expected plan-step generation.
4. Pass and validate the expected requirement execution generation.
5. Keep backlog mutation callbacks pure.
6. Preserve WIP=1 and dependency invariants.
7. Do not mark backlog work `done` before Judge approval and persisted step completion.
8. Do not convert infrastructure failures into product attempt consumption.
9. Keep deployment recovery correlation exact.
10. Verify terminal transitions clear infrastructure state.
11. Ensure finalization remains inside the atomic RPC.
12. Test duplicate events, stale generations, concurrent mutations, retries, and terminal-state preservation.

## Primary code map

- Scheduler: `src/app/api/cron/requirements-apps/route.ts`
- Scheduler state preparation: `src/app/api/cron/requirements-apps/route-state.ts`
- Main workflow: `src/app/api/cron/requirements-apps/workflow.ts`
- Coordinator: `src/app/api/cron/shared/cron-orchestrator-step.ts`
- Executor: `src/app/api/cron/shared/single-turn-executor.ts`
- Integrated gate: `src/app/api/cron/shared/single-turn-gate.ts`
- Gate dispatcher: `src/app/api/cron/shared/gates/index.ts`
- Application gate: `src/app/api/cron/shared/step-git-gate.ts`
- Runtime/visual probes: `src/app/api/cron/shared/step-gate-probes.ts`
- Interaction audit: `src/app/api/cron/shared/step-interaction-audit.ts`
- Interaction remediation: `src/app/api/cron/shared/step-interaction-backlog.ts`
- Visual critic: `src/app/api/cron/shared/step-visual-critic.ts`
- Deterministic Critic/Judge: `src/app/api/cron/shared/archetype-runner.ts`
- Post-gate evidence: `src/app/api/cron/shared/step-archetype-postgate.ts`
- Infrastructure execution guards: `src/app/api/cron/shared/cron-execute-steps-phase-helpers.ts`
- Final status policy: `src/app/api/cron/shared/cron-workflow-finalize.ts`
- Atomic finalization client: `src/lib/services/requirement-finalization.ts`
- Backlog API: `src/lib/services/requirement-backlog.ts`
- Backlog CAS: `src/lib/services/requirement-backlog-mutation.ts`
- Backlog invariants: `src/lib/services/requirement-backlog-invariants.ts`
- Self-healing: `src/lib/services/requirement-self-heal.ts`
- Deployment recovery: `src/lib/services/deployment-infrastructure-recovery.ts`
- Vercel webhook processing: `src/lib/integrations/vercel/process-webhook.ts`
