# Cloud file contracts without a sandbox

Status: **six blocked behavioral cases; no cloud file implementation or live run**.
This suite is separate from the five production requirement/sandbox canaries.
It must not be counted as additional production passes.

The proposed behavior comes from section 9.4 of
[the harness plan](ASSISTANT_HARNESS_SIMPLIFICATION_PLAN_2026-10-28.md).
`edit_cloud_file` is not implemented. Cloud search/read API names are not yet
selected; these scenarios deliberately specify operations rather than inventing
registered tools. Existing `search`, `read_files` and `apply_patch` operate on a
workspace and cannot satisfy these no-sandbox contracts.

## Cases

| ID | Required behavior |
| --- | --- |
| `cloud-search-name` | Find an authorized private document by name with pagination and tenant isolation. |
| `cloud-search-content` | Search cloud document content without searching the workspace. |
| `cloud-write-read` | Create a private UTF-8 document, obtain a durable ID/version and independently read exact bytes. |
| `cloud-replace-read` | Replace using ID/expected version; preserve identity and previous version; read exact new bytes. |
| `cloud-patch-read` | Apply an exact bounded change against the expected version and verify the resulting bytes. |
| `cloud-stale-version` | Reject an obsolete version with a conflict, return the current version and preserve its bytes. |

All cases require trusted actor/site/instance scope, zero sandbox provider calls,
no workspace fallback, and no artificial requirement or repository prerequisite.
Hashes and UTF-8 byte lengths are fixed independent expectations, not derived from
assistant claims. Future live adapters must provide authorized storage reads,
persisted version receipts and resource audit evidence before producing passes.

## Commands

```sh
# Print the six definitions; no credentials, providers, database or dotenv.
npm run test:harness:cloud -- list

# Emit a JSON blocked report and exit 2 intentionally.
npm run test:harness:cloud

# Validate case definitions, exact-byte oracles and blocked CLI behavior offline.
npm run test:harness:cloud:unit
```

The offline unit tests passing means the contract reporter is correct. It does
**not** mean cloud operations work. Reports always set `healthGreen=false`,
`behaviorPassed=false`, `liveExecution=false`, and `executed=false` for every case.
No live mutation mode or skip-to-pass switch exists. The zero provider-call count
currently reflects no execution, not proof of a functioning no-sandbox executor.

The harness CI runs the offline unit command only; the intentionally blocked
behavior report is not hidden behind `continue-on-error` or reclassified as a pass.