/**
 * Minimal type surface for Vercel webhook payloads.
 *
 * Vercel emits many event types; we only care about `deployment.*` and keep
 * everything else loose (`Record<string, unknown>`) so unknown fields do not
 * break parsing. The shape follows the public docs:
 * https://vercel.com/docs/webhooks/webhooks-api
 */

export type VercelDeploymentEventType =
  | 'deployment.created'
  | 'deployment.building'
  | 'deployment.ready'
  | 'deployment.succeeded'
  | 'deployment.error'
  | 'deployment.canceled'
  | 'deployment.promoted';

export const VERCEL_DEPLOYMENT_EVENT_TYPES: ReadonlySet<VercelDeploymentEventType> = new Set([
  'deployment.created',
  'deployment.building',
  'deployment.ready',
  'deployment.succeeded',
  'deployment.error',
  'deployment.canceled',
  'deployment.promoted',
]);

export interface VercelDeploymentMeta {
  /** Branch name (git ref) that triggered the deployment. Primary resolver key. */
  githubCommitRef?: string | null;
  /** Commit SHA on the ref. */
  githubCommitSha?: string | null;
  githubCommitMessage?: string | null;
  githubCommitAuthorName?: string | null;
  githubCommitAuthorLogin?: string | null;
  /** GitHub repo slug (no owner). */
  githubRepo?: string | null;
  /** GitHub repo owner (org/user). */
  githubOrg?: string | null;
  /** GitHub repo id (numeric, as string). */
  githubRepoId?: string | null;
  /** Alt keys seen in the wild for non-GitHub git providers. */
  gitlabProjectPath?: string | null;
  bitbucketRepoName?: string | null;
  [key: string]: unknown;
}

export interface VercelDeploymentPayload {
  /** `dpl_*` id. */
  id?: string;
  /** Canonical `<project>-<hash>-<team>.vercel.app` host (no scheme). */
  url?: string | null;
  name?: string | null;
  inspectorUrl?: string | null;
  meta?: VercelDeploymentMeta | null;
  target?: string | null;
  source?: string | null;
  /** ISO timestamp when Vercel received the deployment. */
  createdAt?: number | string | null;
  [key: string]: unknown;
}

export interface VercelWebhookProject {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface VercelWebhookPayloadBody {
  deployment?: VercelDeploymentPayload;
  project?: VercelWebhookProject;
  /** Vercel often duplicates projectId at the payload root. */
  projectId?: string;
  team?: { id?: string; slug?: string } | null;
  /** Machine-readable failure code for deployment.error (e.g. "BUILD_FAILED"). */
  errorCode?: string | null;
  errorMessage?: string | null;
  [key: string]: unknown;
}

export interface VercelWebhookEvent {
  /** Vercel event id, unique per delivery (used for dedupe). */
  id: string;
  type: string;
  createdAt: number;
  region?: string | null;
  payload: VercelWebhookPayloadBody;
}

export function isVercelWebhookEvent(value: unknown): value is VercelWebhookEvent {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return false;
  if (typeof o.type !== 'string' || !o.type) return false;
  if (typeof o.createdAt !== 'number') return false;
  if (!o.payload || typeof o.payload !== 'object') return false;
  return true;
}

export function isVercelDeploymentEventType(type: string): type is VercelDeploymentEventType {
  return VERCEL_DEPLOYMENT_EVENT_TYPES.has(type as VercelDeploymentEventType);
}
