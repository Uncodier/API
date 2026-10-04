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
  try {
    const client = await requireDeletionUser(request, signal);
    const { instance_id } = await readDeletionRequest(request, signal);
    // This read-only RPC derives the site and checks owner/admin plus all linked ownership.
    const preflight = await withSignal(() => client.rpc('get_robot_instance_deletion_scope', {
      p_instance_id: instance_id,
    }), signal);
    if (preflight.error) throw rpcFailure(preflight.error, false);
    const scope = scopeSchema.safeParse(preflight.data);
    if (!scope.success || scope.data.instance_id !== instance_id) {
      throw new DeletionError(503, 'deletion_unavailable', 'Instance deletion authorization could not be verified.');
    }
    await stopDeletionProvider(scope.data, signal);
    // No plan updates, log batches, or fallback deletes: all DB mutation belongs to one transaction.
    const deletion = await withSignal(() => client.rpc('delete_robot_instance_with_requirements', {
      p_instance_id: instance_id,
      p_expected_requirement_ids: scope.data.requirement_ids,
      p_expected_provider: scope.data.provider,
      p_expected_provider_instance_id: scope.data.provider_instance_id,
      p_expected_status: scope.data.status,
    }), signal);
    if (deletion.error) throw rpcFailure(deletion.error, true);
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
    return NextResponse.json({ success: false, error: { code: safe.code, message: safe.message } }, {
      status: safe.status, headers,
    });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
  }
}
