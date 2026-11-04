// ARM 2024-10-01 CommandJob REST, not az ml YAML. No inference is simulated here.
// https://learn.microsoft.com/azure/templates/microsoft.machinelearningservices/2024-10-01/workspaces/jobs
import * as azureStore from './azure-store.mjs';

const ARM = 'https://management.azure.com';
const API = '2024-10-01';
const UUID = '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}';
const workspacePattern = new RegExp(`^/subscriptions/${UUID}/resourceGroups/[A-Za-z0-9_-]+/providers/Microsoft.MachineLearningServices/workspaces/[A-Za-z0-9_-]+$`);
const validId = id => typeof id === 'string' && /^video_[a-f0-9]{64}$/.test(id);
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
const require = (condition) => { if (!condition) fail('INVALID_DISPATCH_CONFIGURATION'); };

export function createDispatcher({ workspaceId, computeName = 'video-gpu', environmentId,
  workerImage, workerClientId, clientId, storageAccount, licenseProofRef, modelRevision,
  licenseApproved = false, workerReady = false, enabled = false,
  fetchImpl = globalThis.fetch, tokenProvider, timeoutMs = 30_000 } = {}) {
  require(workspacePattern.test(workspaceId || ''));
  require(/^[A-Za-z0-9_-]{1,63}$/.test(computeName));
  require(typeof workerImage === 'string' && /^[a-z0-9][a-z0-9.-]+\/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}$/.test(workerImage));
  const imageDigest = workerImage.split('@sha256:')[1];
  // Digest-addressed environment versions prevent configuration drift/rebuild.
  require(environmentId === `${workspaceId}/environments/video-worker/versions/${imageDigest}`);
  require(new RegExp(`^${UUID}$`).test(workerClientId || ''));
  require(/^[a-z0-9]{3,24}$/.test(storageAccount || ''));
  require(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(licenseProofRef || ''));
  require(/^[a-f0-9]{40}$/.test(modelRevision || ''));
  require(typeof fetchImpl === 'function' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000);
  let getToken = tokenProvider;
  const inFlight = new Map();

  async function request(url, method, body) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          getToken ??= azureStore.createManagedIdentityTokenProvider({ clientId, identity: 'container-apps',
            resource: `${ARM}/`, fetchImpl, timeoutMs });
          const token = await getToken();
          if (controller.signal.aborted) fail('ARM_TIMEOUT');
          require(typeof token === 'string' && token.length > 0 && !/[\r\n]/.test(token));
          const response = await fetchImpl(url, { method, redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
              ...(method === 'PUT' ? { 'If-None-Match': '*' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          if (response.redirected) fail('ARM_REDIRECT_REJECTED');
          // Never expose provider bodies, URLs or token-bearing errors.
          await response.body?.cancel();
          return response.status;
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(Object.assign(new Error('ARM_TIMEOUT'), { code: 'ARM_TIMEOUT' }));
        }, timeoutMs); }),
      ]);
    } catch (error) {
      if (error?.code === 'ARM_TIMEOUT') throw error;
      fail('ARM_REQUEST_FAILED');
    } finally { clearTimeout(timer); }
  }

  async function submit(id) {
    if (enabled !== true || licenseApproved !== true || workerReady !== true) fail('GENERATION_NOT_ENABLED');
    if (!validId(id)) fail('INVALID_VIDEO_ID');
    // Same durable video ID always maps to one AML job. Never mint retry IDs.
    const name = id.replace('_', '-');
    const url = `${ARM}${workspaceId}/jobs/${name}?api-version=${API}`;
    const existing = await request(url, 'GET');
    if (existing === 200) return { id, jobName: name, submitted: false, existing: true };
    if (existing !== 404) fail('ARM_LOOKUP_FAILED', existing);
    const properties = {
      jobType: 'Command', displayName: name, experimentName: 'video-worker',
      computeId: `${workspaceId}/computes/${computeName}`, environmentId,
      command: 'bash /app/start-worker.sh',
      identity: { identityType: 'Managed', clientId: workerClientId },
      resources: { instanceCount: 1, shmSize: '64g' },
      limits: { jobLimitsType: 'Command', timeout: 'PT30M' },
      environmentVariables: {
        VIDEO_JOB_ID: id, VIDEO_STORAGE_ACCOUNT: storageAccount, AZURE_CLIENT_ID: workerClientId,
        VIDEO_STORAGE_IDENTITY: 'imds', VIDEO_WORKER_TIMEOUT_MS: '900000', VIDEO_JOB_LEASE_MS: '1860000',
        H3_LICENSE_APPROVED: 'true', H3_WORKER_READY: 'true', H3_LICENSE_PROOF_REF: licenseProofRef,
        H3_MODEL_REVISION: modelRevision,
      },
    };
    const status = await request(url, 'PUT', { properties });
    if ([200, 201, 202].includes(status)) return { id, jobName: name, submitted: true, existing: false };
    if ([409, 412].includes(status) && await request(url, 'GET') === 200) {
      return { id, jobName: name, submitted: false, existing: true };
    }
    // On timeout/uncertain PUT, caller may dispatch SAME ID; GET reconciles first.
    // No automatic retry or re-launch of failed/cancelled/completed AML jobs.
    fail('ARM_SUBMIT_FAILED', status);
  }

  return Object.freeze({ dispatch(id) {
    if (!validId(id)) return Promise.reject(Object.assign(new Error('INVALID_VIDEO_ID'), { code: 'INVALID_VIDEO_ID' }));
    if (!inFlight.has(id)) {
      const promise = submit(id).finally(() => inFlight.delete(id));
      inFlight.set(id, promise);
    }
    return inFlight.get(id);
  } });
}

export function dispatcherFromEnv(env = process.env) {
  return createDispatcher({ workspaceId: env.VIDEO_AML_WORKSPACE_ID,
    computeName: env.VIDEO_AML_COMPUTE || 'video-gpu', environmentId: env.VIDEO_AML_ENVIRONMENT_ID,
    workerImage: env.VIDEO_WORKER_IMAGE, workerClientId: env.VIDEO_WORKER_CLIENT_ID,
    clientId: env.AZURE_CLIENT_ID, storageAccount: env.VIDEO_STORAGE_ACCOUNT,
    licenseProofRef: env.H3_LICENSE_PROOF_REF, modelRevision: env.H3_MODEL_REVISION,
    licenseApproved: env.H3_LICENSE_APPROVED === 'true', workerReady: env.H3_WORKER_READY === 'true',
    enabled: env.VIDEO_GENERATION_ENABLED === 'true' });
}

let defaultDispatcher;
export async function dispatch(id) {
  defaultDispatcher ??= dispatcherFromEnv();
  return defaultDispatcher.dispatch(id);
}