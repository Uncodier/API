const states = ['queued', 'sending', 'sent', 'failed', 'delivered', 'read'] as const;
export type ZavuReceiptStatus = typeof states[number];
export type ZavuAcceptedStatus = Exclude<ZavuReceiptStatus, 'failed'>;

export function isZavuAcceptedStatus(value: unknown): value is ZavuAcceptedStatus {
  return typeof value === 'string' && value !== 'failed' && states.includes(value as ZavuReceiptStatus);
}

// Positive arrival evidence outranks a failure; a late acknowledgement cannot
// clear a failure, a delivery event or a read receipt for the same provider ID.
export function strongerZavuStatus(previous: unknown, next: ZavuReceiptStatus): ZavuReceiptStatus {
  return states.indexOf(previous as ZavuReceiptStatus) > states.indexOf(next) ? previous as ZavuReceiptStatus : next;
}
