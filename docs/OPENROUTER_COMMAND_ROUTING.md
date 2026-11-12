# Legacy command and Gear routing checkpoint

Local engineering checkpoint, 2026-11-12. No deployment, remote migration or paid
provider verification was performed. The customer activation gate remains closed.

## Durable command boundary

- `command-routing.ts` admits a payer only from host-owned async-local scope.
  Command `user_id`, `metadata`, and model fields are not authentication.
- With activation enabled, an unscoped submission is rejected rather than selecting
  a customer account from request fields or silently spending the platform account.
- `CommandSubmitService` persists the dedicated routing pin before emitting the
  queue event. A customer database failure or a pin failure never becomes an
  in-memory fallback. Pre-schema global/local behavior remains available.
- `AgentInitializer` restores routing before background generation, and
  `CommandProcessor` independently restores it for direct processing. The immutable
  pin wins over command metadata. Missing pins and database errors fail closed.
- Supervisor analysis restores the original command pin before creating its child
  command. Supervisor-only inference has a separate operation phase. Factory and
  supervisor connectors no longer capture the environment key in configuration;
  credentials are resolved by the shared client at actual dispatch.
- Stable command UUID/phase operation namespaces reach the shared durable dispatch
  intent. A missing/uncertain provider receipt never permits platform fallback.
- The migration snapshots existing site-bound commands as explicit platform work.
  New jobs must acquire pins; runtime does not infer legacy status from a mutable
  command timestamp. Tables deny browser access and direct service-role writes;
  the narrow RPC validates site, selected connection and policy/key versions.

`OPENROUTER_ROUTING_STORAGE_READY=true` is a deployment prerequisite after the
forward migration `20261112021000_openrouter_command_routing.sql`. Keep it enabled
during rollout rollback: disabling admission must not erase existing customer
attribution. Before first deployment, the false setting avoids new schema reads.

## Gear boundaries

Registered email and WhatsApp handlers resolve routing only after existing project
access resolution. Their durable workflow input includes the reference and passes
it to assistant execution. Legacy workflow inputs explicitly retain platform payer.
Unregistered/project-selection lobby inference is intentionally platform-owned:
an unregistered identity or generic lobby site is not authorization to spend a
customer connection. The lobby executor constructs its client inside that explicit
platform scope. Delivery and channel charges remain independent.

## Remaining admission work (handoff, not completed coverage)

The legacy public command entrypoints still need authenticated host scope wrappers
around their business execution before activation. `authorizeInferenceRequest` and
`withHttpExecutionRouting` provide the shared credential/site and signed-ticket
contract; client-supplied user IDs must not replace it. The coordinating follow-up
owns all discovered command route families: chat, CMO standups/message/stakeholder
coordination, copywriter, customer support, data analyst, email, growth requirements,
sales, and the WhatsApp agent integration. Also audit service/helper direct
`executeCommand` callers rather than assuming `submitCommand` search is exhaustive.

Safe rejection of unscoped customer work is a containment measure, not completion
of those route integrations. The overall runtime inventory remains authoritative.

## Offline checks

- Command regression: 15 suites / 146 tests, including disposable socket-only local
  PostgreSQL concurrent pin idempotency, immutable payer, ACL, tenant and key denial.
- Gear workflow/recovery and delivery: 2 ESM suites / 34 tests.
- Gear webhook/project/media contracts: 6 CommonJS suites / 60 tests.
- Full API TypeScript check passed before the last regression additions. The later
  concurrent recheck reported plan-act narrowing errors outside this change; the
  coordinating task must rerun after that work completes.
- No live provider calls, remote schema changes, builds, commits or deployments.