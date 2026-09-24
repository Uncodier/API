import { describe, expect, it } from '@jest/globals';
import { reconcileOutstandStatus } from '../inbox-sync';

describe('Outstand inbox delivery status reconciliation', () => {
  it('does not regress a terminal status to pending', () => {
    expect(reconcileOutstandStatus('sent', 'pending')).toBe('sent');
    expect(reconcileOutstandStatus('failed', 'pending')).toBe('failed');
    expect(reconcileOutstandStatus('read', 'pending')).toBe('read');
  });

  it('does not regress read to sent', () => {
    expect(reconcileOutstandStatus('read', 'sent')).toBe('read');
  });

  it('allows a pending message to reach a terminal state', () => {
    expect(reconcileOutstandStatus('pending', 'sent')).toBe('sent');
    expect(reconcileOutstandStatus('pending', 'failed')).toBe('failed');
  });
});
