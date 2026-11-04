#!/usr/bin/env bash
set -euo pipefail
# A command job owns the runtime. Never expose the model server publicly.
[[ "${H3_LICENSE_APPROVED:-}" == true ]] || { echo 'H3 authorization required' >&2; exit 1; }
[[ "${H3_WORKER_READY:-}" == true ]] || { echo 'Worker activation required' >&2; exit 1; }
[[ "${VIDEO_JOB_ID:-}" =~ ^video_[a-f0-9]{64}$ ]] || { echo 'Job ID required' >&2; exit 1; }
[[ "${H3_MODEL_REVISION:-}" =~ ^[a-f0-9]{40}$ ]] || { echo 'Pinned model revision required' >&2; exit 1; }
model_dir="${H3_MODEL_DIR:-/tmp/h3-model}"
runtime_pid=''
work_pid=''
cleanup() {
  if [[ -n "$work_pid" ]]; then
    kill -- "-$work_pid" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$work_pid" 2>/dev/null || true
  fi
  if [[ -n "$runtime_pid" ]]; then
    kill -- "-$runtime_pid" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$runtime_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT
# Runtime logs may contain prompts: restrict local files; never ship them to public logs.
umask 077
setsid timeout --kill-after=10 300 hf download MiniMaxAI/MiniMax-H3 --revision "$H3_MODEL_REVISION" \
  --include 'model_index.json' 'FL2VA/*' --local-dir "$model_dir" >/tmp/h3-download.log 2>&1 &
work_pid=$!
wait "$work_pid"
work_pid=''
setsid sglang serve --model-path "$model_dir" --num-gpus 4 --ulysses-degree 4 \
  --performance-mode speed --host 127.0.0.1 --port 30010 --model-variant fl2va \
  >/tmp/h3-runtime.log 2>&1 &
runtime_pid=$!
ready=false
for ((i=0; i<60; i++)); do
  kill -0 "$runtime_pid" 2>/dev/null || { echo 'Model runtime exited before readiness' >&2; exit 1; }
  if curl --fail --silent --max-time 3 http://127.0.0.1:30010/health >/dev/null; then
    ready=true
    break
  fi
  sleep 5
done
[[ "$ready" == true ]] || { echo 'Model runtime readiness deadline exceeded' >&2; exit 1; }
setsid timeout --signal=TERM --kill-after=15 960 node /app/worker.mjs &
work_pid=$!
wait "$work_pid"
work_pid=''