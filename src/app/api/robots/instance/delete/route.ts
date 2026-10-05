import { NextRequest, NextResponse } from 'next/server';
import {
  DeletionError, readDeletionRequest, requireDeletionUser, resultSchema, rpcFailure,
  scopeSchema, stopDeletionProvider, unconfirmedDeletion, withSignal,
} from './deletion-request';

export const maxDuration = 600;

export async function POST(request: NextRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 550_000);
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const signal = controller.signal;
  const headers = { 'Cache-Control': 'no-store' };
  let stage = 'authentication';
  let databaseCode: string | null = null;
  try {
    const client = await requireDeletionUser(request, signal);
    stage = 'request_validation';
    const { instance_id } = await readDeletionRequest(request, signal);
    // This read-only RPC derives the site and checks owner/admin plus all linked ownership.
    stage = 'preflight';
    const preflight = await withSignal(() => client.rpc('get_robot_instance_deletion_scope', {
      p_instance_id: instance_id,
    }), signal);
    if (preflight.error) {
      databaseCode = /^[0-9A-Z]{5}$|^PGRST[0-9]{3}$/.test(preflight.error.code) ? preflight.error.code : null;
      throw rpcFailure(preflight.error, false);
    }
    const scope = scopeSchema.safeParse(preflight.data);
    if (!scope.success || scope.data.instance_id !== instance_id) {
      throw new DeletionError(503, 'deletion_unavailable', 'Instance deletion authorization could not be verified.');
    }
    stage = 'provider_stop';
    await stopDeletionProvider(scope.data, signal);
    // No plan updates, log batches, or fallback deletes: all DB mutation belongs to one transaction.
    stage = 'database_deletion';
    const deletion = await withSignal(() => client.rpc('delete_robot_instance_with_requirements', {
      p_instance_id: instance_id,
      p_expected_requirement_ids: scope.data.requirement_ids,
      p_expected_provider: scope.data.provider,
      p_expected_provider_instance_id: scope.data.provider_instance_id,
      p_expected_status: scope.data.status,
    }), signal);
    if (deletion.error) {
      databaseCode = /^[0-9A-Z]{5}$|^PGRST[0-9]{3}$/.test(deletion.error.code) ? deletion.error.code : null;
      throw rpcFailure(deletion.error, true);
    }
    stage = 'receipt_validation';
    const result = resultSchema.safeParse(deletion.data);
    if (!result.success || result.data.instance_id !== instance_id
      || result.data.deleted_requirement_ids.length !== scope.data.requirement_ids.length
      || result.data.deleted_requirement_ids.some(id => !scope.data.requirement_ids.includes(id))) {
      throw unconfirmedDeletion();
    }
    return NextResponse.json({
      success: true,
      instance_id,
      deleted_requirement_ids: result.data.deleted_requirement_ids,
      message: 'Instance and associated requirements deleted successfully.',
    }, { headers });
  } catch (error) {
    const safe = error instanceof DeletionError ? error : unconfirmedDeletion();
    // Never log raw errors, credentials, resource IDs, or database/provider payloads.
    console.error('[instance/delete] Failed', {
      stage, status: safe.status, code: safe.code, database_code: databaseCode,
    });
    return NextResponse.json({ success: false, error: { code: safe.code, message: safe.message } }, {
      status: safe.status, headers,
    });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
  }
}
