/** Version of the local context contract, not proof of a deployment or model input. */
export const ASSISTANT_CONTEXT_VERSION = 'image-entity-v2';

/** Only public deployment identifiers; never copy arbitrary environment values. */
export function assistantRuntimeProvenance(env: Record<string, string | undefined> = process.env) {
  const commit = env.VERCEL_GIT_COMMIT_SHA;
  const deployment = env.VERCEL_DEPLOYMENT_ID;
  return {
    context_version: ASSISTANT_CONTEXT_VERSION,
    ...(commit && /^[a-f0-9]{40}$/i.test(commit) ? { runtime_commit_sha: commit } : {}),
    ...(deployment && /^dpl_[a-zA-Z0-9]{1,100}$/.test(deployment) ? { runtime_deployment_id: deployment } : {}),
  };
}