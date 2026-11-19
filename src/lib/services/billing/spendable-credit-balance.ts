import { sumCreditBalances } from './credit-balance-sum';

/** Use only after renewal for admission. This is a pre-check, never a reservation. */
export function spendableCreditBalance(billing: {
  credits_available?: unknown;
  account_balance?: unknown;
} | null | undefined): number | null {
  const regular = billing?.credits_available;
  // SQL coalesces an explicit nullable wallet to zero. A missing selected column
  // is unknown, not proof of zero (it could hide a negative wallet).
  const wallet = billing?.account_balance === null ? 0 : billing?.account_balance;
  if (typeof regular !== 'number' || !Number.isFinite(regular) || regular < 0 ||
    typeof wallet !== 'number' || !Number.isFinite(wallet)) return null;
  const total = sumCreditBalances(regular, wallet);
  return Number.isFinite(total) ? total : null;
}