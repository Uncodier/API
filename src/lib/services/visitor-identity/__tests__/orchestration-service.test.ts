import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  VisitorIdentityService
} from '@/lib/services/visitor-identity/orchestration-service';
import {
  visitorIdentityEmailService
} from '@/lib/services/visitor-identity/email-service';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
    rpc: jest.fn()
  }
}));

jest.mock('@/lib/services/leads/lead-service', () => ({
  manageLeadCreation: jest.fn()
}));

jest.mock('@/lib/services/visitor-identity/email-service', () => ({
  visitorIdentityEmailService: {
    sendCode: jest.fn()
  }
}));

describe('VisitorIdentityService challenge issuance', () => {
  const from = supabaseAdmin.from as jest.Mock;
  const rpc = supabaseAdmin.rpc as jest.Mock;
  const sendCode = visitorIdentityEmailService.sendCode as jest.Mock;
  const params = {
    siteId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    visitorId: '33333333-3333-4333-8333-333333333333',
    leadId: '44444444-4444-4444-8444-444444444444',
    email: 'person@example.com',
    requestIp: '203.0.113.10'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VISITOR_IDENTITY_OTP_HMAC_SECRET = 'test-secret-with-at-least-32-characters';
  });

  it('reuses an active challenge without sending another email', async () => {
    rpc.mockResolvedValue({
      data: {
        status: 'existing',
        challenge_id: '55555555-5555-4555-8555-555555555555',
        masked_email: 'pe****@example.com',
        expires_at: '2026-09-18T08:00:00.000Z',
        resend_available_at: '2026-09-18T07:51:00.000Z'
      },
      error: null
    });

    const result = await (
      new VisitorIdentityService() as unknown as {
        issueChallenge: (input: typeof params) => Promise<Record<string, unknown>>;
      }
    ).issueChallenge(params);

    expect(result).toEqual({
      identity_status: 'verification_required',
      challenge_id: '55555555-5555-4555-8555-555555555555',
      masked_email: 'pe****@example.com',
      expires_at: '2026-09-18T08:00:00.000Z',
      resend_available_at: '2026-09-18T07:51:00.000Z'
    });
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('restores an active grant without issuing a challenge or email', async () => {
    from
      .mockReturnValueOnce(queryResult({
        id: params.sessionId,
        site_id: params.siteId,
        visitor_id: params.visitorId,
        lead_id: params.leadId,
        is_active: true
      }))
      .mockReturnValueOnce(queryResult({
        id: params.leadId,
        email: params.email
      }))
      .mockReturnValueOnce(queryResult({ lead_id: params.leadId }));

    await expect(new VisitorIdentityService().restore(params)).resolves.toEqual({
      identity_status: 'verified',
      lead_id: params.leadId
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(sendCode).not.toHaveBeenCalled();
  });
});

function queryResult(data: unknown) {
  const builder: Record<string, jest.Mock> = {};
  for (const method of ['select', 'eq', 'ilike', 'order', 'limit', 'is', 'or']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.maybeSingle = jest.fn().mockResolvedValue({ data, error: null });
  return builder;
}
