import 'server-only';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { decryptCredential } from './crypto';
import { parseCapabilities, parseRow } from './validation';
import { type ConnectionRow, type CredentialReference, type CustomerSelection, OpenRouterError } from './types';

// Management callers must authorize the actor first; runtime callers must supply
// a server-derived site, never an untrusted body or forwarded payer assertion.
export async function readConnection(siteId: string): Promise<ConnectionRow | null> {
  const { data, error } = await supabaseAdmin.from('openrouter_customer_connections').select('*').eq('site_id', siteId).maybeSingle();
  if (error) throw new OpenRouterError('connection_unavailable', 'Connection storage is unavailable');
  return data === null ? null : parseRow(data);
}
export async function getCustomerSelection(siteId: string): Promise<CustomerSelection | null> {
  const row = await readConnection(siteId);
  if (!row || !row.selected) return null;
  if (row.status !== 'connected') throw new OpenRouterError('connection_revoked', 'Customer connection is revoked');
  await assertRolloutApproval(siteId);
  return { siteId, connectionId: row.id, revision: row.revision, policyVersion: row.policy_version, credentialVersion: row.credential_version, capabilities: row.capabilities };
}
export async function resolveCustomerCredential(ref: CredentialReference) {
  const row = await readConnection(ref.siteId);
  if (!row || row.id !== ref.connectionId || !row.selected || row.status !== 'connected' ||
    row.credential_version !== ref.credentialVersion || !row.encrypted_credential) throw new OpenRouterError('connection_revoked', 'Customer connection was revoked or rotated');
  await assertRolloutApproval(ref.siteId);
  const { data, error } = await supabaseAdmin.from('openrouter_customer_policies')
    .select('capabilities,credential_version').eq('connection_id', row.id).eq('policy_version', ref.policyVersion).maybeSingle();
  if (error) throw new OpenRouterError('policy_unavailable', 'Connection policy storage is unavailable');
  if (!data || data.credential_version !== ref.credentialVersion) throw new OpenRouterError('policy_unavailable', 'Pinned connection policy is unavailable');
  const capabilities = parseCapabilities(data.capabilities);
  return { apiKey: decryptCredential(row.encrypted_credential, row.site_id, row.id, row.credential_version), capabilities, catalog: row.catalog };
}
async function assertRolloutApproval(siteId: string) {
  const { data, error } = await supabaseAdmin.from('openrouter_rollout_approvals').select('approved_until').eq('site_id',siteId).maybeSingle();
  if (error || !data || !Number.isFinite(Date.parse(data.approved_until)) || Date.parse(data.approved_until)<=Date.now()) {
    throw new OpenRouterError('rollout_not_approved','Customer execution approval is missing or expired',409);
  }
}
function storageError(error: { code?: string } | null): never {
  if (error?.code === '40001' || error?.code === '23505') throw new OpenRouterError('revision_conflict', 'Connection changed. Reload before saving.', 409);
  if (error?.code === '42501') throw new OpenRouterError('forbidden', 'Owner or administrator access is required', 403);
  if (error?.code === '55000') throw new OpenRouterError('rollout_not_approved','Customer execution has not been approved for this site',409);
  throw new OpenRouterError('connection_unavailable', 'Connection storage is unavailable');
}
export async function publishConnection(siteId: string, actorId: string, revision: number, candidate: ConnectionRow, refreshToken?: string): Promise<ConnectionRow> {
  const { data, error } = await supabaseAdmin.rpc('openrouter_customer_publish', { p_site_id: siteId, p_actor_id: actorId, p_expected_revision: revision, p_candidate: candidate, p_refresh_token: refreshToken ?? null });
  if (error || !data) storageError(error);
  return parseRow(data);
}
export async function claimRefresh(siteId: string, actorId: string, revision: number, token: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('openrouter_customer_refresh_claim', { p_site_id: siteId, p_actor_id: actorId, p_expected_revision: revision, p_token: token });
  if (error) storageError(error);
  if (data !== true) throw new OpenRouterError('refresh_conflict', 'Refresh already running or connection changed', 409);
}
export async function releaseRefresh(siteId: string, token: string): Promise<void> {
  // Lease expiry is the recovery path if cleanup fails. Never replay discovery.
  await supabaseAdmin.rpc('openrouter_customer_refresh_release', { p_site_id: siteId, p_token: token });
}
