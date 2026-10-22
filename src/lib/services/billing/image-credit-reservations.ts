import { createHash, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';

type Receipt = { success: boolean; created?: boolean; state?: string; code?: string; charged?: number };
export class ImageReservationError extends Error {
  constructor(public readonly code: string, public readonly status = 503) {
    super('Image credit admission unavailable');
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function imageOperationIdentity(siteId: string, key: string | null, internal: boolean, payload: unknown) {
  if (key !== null && (!internal || !/^[A-Za-z0-9:_-]{1,128}$/.test(key))) {
    throw new ImageReservationError('INVALID_IDEMPOTENCY_KEY', 400);
  }
  return { siteId, operationId: hash(`${siteId.toLowerCase()}:${key ?? randomUUID()}`),
    requestHash: hash(JSON.stringify(payload)), token: randomUUID() };
}
export type ImageReservation = ReturnType<typeof imageOperationIdentity>;
async function rpc(name: string, parameters: Record<string, unknown>): Promise<Receipt> {
  // No automatic RPC retry: a missing response cannot grant dispatch authorization.
  const { data, error } = await supabaseAdmin.rpc(name, parameters);
  if (error || !data || typeof data.success !== 'boolean') throw new ImageReservationError('BILLING_UNAVAILABLE');
  return data as Receipt;
}
const owned = (r: ImageReservation) => ({ p_site_id: r.siteId, p_operation_id: r.operationId, p_token: r.token });
export async function holdImageCredits(r: ImageReservation, count: number) {
  const receipt = await rpc('hold_image_generation_credits', { ...owned(r), p_request_hash: r.requestHash, p_count: count });
  if (!receipt.success) throw new ImageReservationError(receipt.code ?? 'BILLING_UNAVAILABLE',
    receipt.code === 'INSUFFICIENT_CREDITS' ? 402 : receipt.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 503);
  if (receipt.created !== true || receipt.state !== 'reserved') throw new ImageReservationError('IMAGE_OPERATION_ALREADY_EXISTS', 409);
}
export async function dispatchImageCredits(r: ImageReservation) {
  const receipt = await rpc('dispatch_image_generation_reservation', owned(r));
  if (!receipt.success || receipt.state !== 'dispatched') throw new ImageReservationError('DISPATCH_NOT_CLAIMED', 409);
}
export async function settleImageCredits(r: ImageReservation, count: number, generationId?: string, model?: string) {
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new ImageReservationError('INVALID_OUTPUT_COUNT');
  const receipt = await rpc('settle_image_generation_reservation', {
    ...owned(r), p_count: count, p_generation_id: generationId ?? null, p_model: model ?? null,
  });
  if (!receipt.success || receipt.state !== 'settled' || receipt.charged !== count / 10) {
    throw new ImageReservationError('SETTLEMENT_UNCONFIRMED');
  }
}
export async function releaseImageCredits(r: ImageReservation, reason: 'not_dispatched' | 'confirmed_admission_rejection') {
  const receipt = await rpc('release_image_generation_reservation', { ...owned(r), p_reason: reason });
  if (!receipt.success || receipt.state !== 'released') throw new ImageReservationError('RELEASE_UNCONFIRMED');
}
export async function markImageCreditsPending(r: ImageReservation) {
  await rpc('mark_image_generation_reservation_pending', owned(r));
}