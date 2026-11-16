import { isTransientAssistantFailure, getProviderRetryDecision } from '@/lib/services/robot-instance/assistant-failure-policy';

describe('transient assistant failure classification', () => {
  it.each([429, 500, 502, 503, 504])('accepts transient admission HTTP %s', status => {
    expect(isTransientAssistantFailure({ status })).toBe(true);
    expect(isTransientAssistantFailure({ statusCode: status })).toBe(true);
  });
  it.each([400, 401, 403, 404, 422])('rejects permanent HTTP %s', status => {
    expect(isTransientAssistantFailure({ status })).toBe(false);
  });
  it('recognizes typed connection failures and nested causes, not error text', () => {
    expect(isTransientAssistantFailure({ cause: { code: 'EAI_AGAIN' } })).toBe(true);
    expect(isTransientAssistantFailure({ name: 'APIConnectionTimeoutError' })).toBe(false);
    expect(isTransientAssistantFailure(new Error('503 timeout exceeded max retries'))).toBe(false);
    expect(isTransientAssistantFailure({ name: 'AbortError' })).toBe(false);
  });
  it.each([{ status: 408 }, { code: 'ECONNRESET' }, { code: 'ETIMEDOUT' }, { name: 'TimeoutError' }])('rejects ambiguous inference %j', error => {
    expect(getProviderRetryDecision(error)).toBeUndefined();
  });
  it('preserves seconds, HTTP dates and sanitized customer deadlines', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const deadline = now + 3600000;
    expect(getProviderRetryDecision({ status: 429, headers: { 'retry-after': '3600' } }, now)).toEqual({ retryAt: deadline });
    expect(getProviderRetryDecision({ status: 503, headers: { get: () => new Date(deadline).toUTCString() } }, now)).toEqual({ retryAt: deadline });
    expect(getProviderRetryDecision({ name: 'CustomerRoutingError', code: 'CUSTOMER_PROVIDER_TRANSIENT_REJECTED', status: 422, retryNotBefore: deadline }, now)).toEqual({ retryAt: deadline });
    expect(getProviderRetryDecision({ name: 'CustomerRoutingError', code: 'CUSTOMER_PROVIDER_REJECTED', status: 422 }, now)).toBeUndefined();
  });
  it.each(['invalid', 'Infinity', '86401'])('does not shorten or ignore invalid/unbounded Retry-After %s', value => {
    expect(getProviderRetryDecision({ status: 429, headers: { 'retry-after': value } })).toBeUndefined();
  });
  it('checks acceptance in the whole cause chain before accepting an outer status', () => {
    expect(getProviderRetryDecision({ status: 503, cause: { generationId: 'synthetic-generation' } })).toBeUndefined();
    expect(getProviderRetryDecision({ status: 503, cause: { name: 'OpenRouterBillingError' } })).toBeUndefined();
  });
  it('bounds cyclic causes and rejects missing failures', () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(isTransientAssistantFailure(error)).toBe(false);
    expect(isTransientAssistantFailure(null)).toBe(false);
  });
});