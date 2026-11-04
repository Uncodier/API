# One-shot H3 worker (Node standard library)

`worker.mjs` is orchestration, not a model implementation. It contains no fake
production inference, subprocess model launcher, runtime installer, checkpoint
download, Azure provisioning, or fallback generator. The model runtime must be
supplied externally and is **not available or validated by these files**. Offline
tests do not establish GPU availability, licensing approval, working weights,
image compatibility, real inference latency, or generated-video quality.

The protocol is based on the official
[SGLang MiniMax-H3 cookbook](https://docs.sglang.io/cookbook/diffusion/MiniMax/MiniMax-H3).
Its FL2VA partition serves `t2va`; selecting and pinning a compatible SGLang image,
model revision and GPU recipe is the external deployment's responsibility.
This worker never invents a model/runtime package or installs one.

## Runtime boundary

Only `http://127.0.0.1:30010` is used. There is no configurable inference URL.
Run the runtime in the same isolated command/container and bind it to loopback;
do not expose its unauthenticated inference port publicly. Only one invocation
may own that runtime. After a successful durable claim, the worker submits once:

```json
{
  "task": "t2va",
  "prompt": "the durable job's prompt",
  "conditions": [],
  "target": { "short_edge": 768, "aspect_ratio": "16:9", "duration_seconds": 4 },
  "seed": 0
}
```

The seed above illustrates its type; the validated durable uint32 request seed
is forwarded unchanged (default zero). The
durable claim supplies the prompt, 4–15 second duration and allowed aspect ratio
(`16:9`, `9:16`, `1:1`), not untrusted caller data or a queue payload.

The worker polls `GET /v1/videos/{id}` until `completed`. Only `queued` and
`in_progress` are accepted nonterminal states. A failed/unknown state, malformed
response, or changed ID fails closed. The worker downloads
`GET /v1/videos/{id}/content`; returned URLs are ignored. IDs are restricted to
ASCII alphanumerics, underscore and hyphen, so they cannot change the endpoint.
All HTTP requests reject redirects. POST is **never retried**, even after a
connection reset, timeout, malformed response, 429, or 5xx. Polls are bounded by
the execution deadline, not an unlimited retry loop.

JSON responses are limited to 64 KiB. Output is bounded to **100 MiB** both by
Content-Length and actual streamed bytes. A `video/mp4` response and basic `ftyp`
header/box-length sanity check are required. This is not an MP4 decoder. The
download is buffered for `uploadContent(id, bytes)`; allow memory for buffering
and concatenation (at least twice the output limit plus runtime/adapter overhead).
Completion metadata is computed locally: storage key, content type, byte count,
SHA-256. No upstream error text or content URLs are persisted or logged.

## Job engine and queue semantics

`runVideoJob({job, store, jobs, owner, fetchImpl, timeoutMs})` uses:

1. `jobs.claim(id, owner)` exactly once. Only a non-null claim authorizes work.
   The returned job must include `lease_expires_at`, `request` and `in_progress`
   status. No inference occurs after an ambiguous claim or insufficient lease.
2. One local submission, bounded polls, bounded content read.
3. `store.uploadContent(id, bytes)` followed by
   `jobs.complete(id, owner, {content_key,content_type,size_bytes,sha256})`.
4. On failure after ownership is established, one bounded
   `jobs.fail(id, owner, safeCode)` attempt. Failure codes are fixed strings;
   causes, headers, raw exception messages and stack traces are not exposed.

The job engine's single-attempt CAS/owner rules are essential: expired leases
must become terminal `execution_ambiguous`, **never requeued/reclaimed** for
another inference. A lease does not prove old GPU work stopped. A lost upload or
complete response can leave an orphan artifact or already-completed job. The
worker reports `uncertain` when it cannot persist a terminal transition; it does
not try generation again. Reusing a job ID is not a recovery method for new GPU
work. Completion artifacts should be reconciled operationally without inference.

`runOnce` takes optional `jobId` (`VIDEO_JOB_ID` in the CLI). With an ID, it never
receives or deletes a queue message; the dispatcher owns its queue lifecycle.
Otherwise it receives at most one message with visibility covering execution
plus 60 seconds. It acknowledges only after a confirmed `completed` or `failed`
transition. Empty queue returns `idle`. Unclaimed/uncertain work is not deleted;
another owner may still be active. Failed acknowledgement is reported as
`queueAcknowledged:false`, without undoing durable completion.

**There is no queue visibility renewal.** Visibility timeout is not the durable
job lease, not a distributed concurrency limit and not a cancellation signal.
Redelivery must pass the same durable claim and can never authorize duplicate
work. A dispatcher or operations reconciliation must clean up terminal leftover
messages; this worker is not a queue-draining daemon. Only one owner/process may
use a runtime at a time. GPU concurrency and monthly spend require separate
deployment/admission controls.

## CLI configuration and lifecycle

Importing the module is side-effect free. Execute `node worker.mjs` on a modern
Node runtime supporting built-in fetch (deployment target Node 24). CLI gates
are checked **before** accessing managed identity, storage, or runtime:

| Variable | Contract |
| --- | --- |
| `H3_LICENSE_APPROVED` | Exactly `true`; approval must also gate the external launcher **before** model download/start. This flag does not itself establish license rights. |
| `H3_WORKER_READY` | Exactly `true`; operator assertion that the external runtime passed its actual startup readiness check. Not an automatic deployment-health proof. |
| `VIDEO_JOB_ID` | Optional `video_` plus 64 lowercase hex characters; direct one-job mode for AML. |
| `VIDEO_STORAGE_ACCOUNT` | Existing Azure Storage account; no account keys or connection strings. |
| `AZURE_CLIENT_ID` | Existing managed-identity client ID. |
| `VIDEO_STORAGE_IDENTITY` | `imds` by default for AML; explicit `container-apps` uses the adapter's `IDENTITY_*` configuration. |
| `VIDEO_WORKER_TIMEOUT_MS` | Integer 1–3,600,000; defaults to 900,000 (15 minutes). |
| `VIDEO_JOB_LEASE_MS` | Defaults to worker timeout + 60,000; must be at least that long and at most 86,400,000. |

The execution timeout covers claim, submission, polling, download, upload and
complete. A separate final failure-write grace is at most 5 seconds. Receive and
acknowledge are separately capped at 15 seconds each. CLI hard exit is execution
timeout + 60 seconds, even if an injected adapter ignores cancellation. Successful
complete/idle/unclaimed outcomes exit 0; failed/uncertain/configuration/deadline
outcomes exit 1. CLI output is bounded, sanitized JSON or a static error code.
SIGTERM/SIGINT abort local work and attempt a bounded failure transition.

**Aborting HTTP or exiting Node does not cancel SGLang GPU computation.** The
external shell/supervisor must bound startup/model load, stop the complete
runtime process group on every Node exit or signal, escalate to a forced kill
after a finite grace, and propagate failure. Configure an AML command-job
wall-time covering startup plus execution and teardown; on completion it must
release the GPU. A long-lived external runtime without teardown does not satisfy
this lifecycle contract. `start-worker.sh` supplies the separate launcher; it
still requires real GPU teardown validation. A wall timeout
alone does not cap a monthly cloud bill.

## Offline verification and real smoke-test gap

Run from the repository root:

```sh
node --test services/azure-video/worker.test.mjs
```

Tests start a mocked SGLang HTTP server on loopback port 30010, which must be
unused; they make no cloud or paid inference calls. They cover real local HTTP
serialization/poll/download, lease/CAS duplicates, ambiguous claim/POST/upload/
complete, finite polling and stalled body timeout, an injected fetch ignoring
abort, redirects/path abuse, streaming and declared output limits, CLI gates,
queue acknowledgement and synthetic credential non-disclosure. Test output bytes
are explicitly a non-decodable MP4-header fixture, never production fallback.

No ffmpeg/ffprobe dependency is added, and no decoder smoke check has been run.
Before readiness is enabled, perform a separately approved real-GPU smoke test
with the pinned external runtime and verify playback. Where independently
available, ffprobe should verify the official output contract: H.264 video at
24 fps, expected duration and roughly aligned 768-pixel short edge, plus AAC
stereo audio at 32 kHz. Verify actual Azure upload/readback digest, private access,
queue behavior, bounded teardown and GPU release. A passing offline suite or
`ftyp` header is not evidence that any of those live checks succeeded.