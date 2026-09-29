import { NextRequest } from 'next/server';
const mockSingle = jest.fn();
const mockProof = jest.fn();
const mockAuthorization = jest.fn();
const mockQuery: any = {};
for (const method of ['select', 'eq', 'is', 'or']) mockQuery[method] = jest.fn(() => mockQuery);
mockQuery.maybeSingle = mockSingle;
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(() => mockQuery) } }));
jest.mock('@/lib/security/visitor-session-token', () => ({ verifiedVisitorSessionClaims: (...args: unknown[]) => mockProof(...args) }));
jest.mock('@/lib/security/authorize-visitor-session', () => ({ authorizeVisitorSession: (...args: unknown[]) => mockAuthorization(...args) }));
jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: jest.fn().mockResolvedValue(null), hasAuthenticatedPrincipal: jest.fn().mockReturnValue(false) }));
jest.mock('../orchestration-service', () => ({ visitorIdentityService: { restore: jest.fn() } }));
import { GET } from '@/app/api/visitors/session/[session_id]/identify/status/route';
import { VisitorSessionAuthorizationService } from '../VisitorSessionAuthorizationService';
import { SUPPORT_SITE_ID } from '../token-crypto';

const sessionId = '11111111-1111-4111-8111-111111111111';
const visitorId = '22222222-2222-4222-8222-222222222222';
const leadId = '33333333-3333-4333-8333-333333333333';
const otherLead = '44444444-4444-4444-8444-444444444444';
const context = { params: Promise.resolve({ session_id: sessionId }) };
const identity = { siteId: SUPPORT_SITE_ID, sessionId, visitorId, leadId };
const request = () => new NextRequest(`http://localhost/api?site_id=${SUPPORT_SITE_ID}&session_id=${sessionId}`, { headers: { 'x-visitor-session-token': 'proof' } });

describe('passive token identity restore and post-logout ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProof.mockResolvedValue({ visitorId });
    mockAuthorization.mockResolvedValue(true);
  });

  it('restores token-only identity with no email/cookie hint', async () => {
    mockSingle.mockResolvedValueOnce({ data: { is_active: true, visitor_id: visitorId, lead_id: leadId }, error: null })
      .mockResolvedValueOnce({ data: { lead_id: leadId, expires_at: '2099-01-01T00:00:00Z' }, error: null });
    const response = await GET(request(), context);
    expect(await response.json()).toEqual({ success: true, data: { identity_status: 'verified', lead_id: leadId, expires_at: '2099-01-01T00:00:00Z' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockQuery.is).toHaveBeenCalledWith('revoked_at', null);
    expect(mockQuery.or).toHaveBeenCalledWith(expect.stringContaining('expires_at.gt.'));
  });

  it('returns anonymous after revocation rather than cached browser identity', async () => {
    mockSingle.mockResolvedValue({ data: { is_active: true, visitor_id: visitorId, lead_id: null }, error: null });
    const response = await GET(request(), context);
    expect(await response.json()).toEqual({ success: true, data: { identity_status: 'anonymous' } });
  });

  it('does not accept a remembered visitor id for an account-owned conversation', async () => {
    mockSingle.mockResolvedValue({ data: { visitor_id: visitorId, lead_id: leadId }, error: null });
    await expect(new VisitorSessionAuthorizationService().assertConversationOwnership({ ...identity, leadId: null }, 'conversation')).rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });
  });

  it('denies another logged-in account even when the browser visitor is unchanged', async () => {
    mockSingle.mockResolvedValue({ data: { visitor_id: visitorId, lead_id: otherLead }, error: null });
    await expect(new VisitorSessionAuthorizationService().assertConversationOwnership(identity, 'conversation')).rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });
  });

  it('allows only unowned anonymous history by visitor or account history by grant', async () => {
    mockSingle.mockResolvedValueOnce({ data: { visitor_id: visitorId, lead_id: null }, error: null })
      .mockResolvedValueOnce({ data: { visitor_id: 'another-browser', lead_id: leadId }, error: null });
    const service = new VisitorSessionAuthorizationService();
    await expect(service.assertConversationOwnership({ ...identity, leadId: null }, 'anonymous')).resolves.toBeUndefined();
    await expect(service.assertConversationOwnership(identity, 'account')).resolves.toBeUndefined();
  });
});