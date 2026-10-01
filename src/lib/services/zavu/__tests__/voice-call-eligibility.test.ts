const mockFrom = jest.fn();
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { from: mockFrom } }));
jest.mock('../voice-call-client', () => ({ placeVoiceCall: jest.fn() }));
jest.mock('../contact-client', () => ({ setVoiceCallContactContext: jest.fn(), clearVoiceCallContactContext: jest.fn() }));
jest.mock('../voice-agent-context', () => ({ ensureVoiceContactMetadataEnabled: jest.fn() }));
jest.mock('../voice-follow-up-context', () => ({ buildVoiceFollowUpContext: jest.fn() }));

import { assertVoiceCallAllowed } from '../voice-call-service';

describe('server-loaded Voice call eligibility boundary', () => {
  const phone = '+14155550100';
  let result: { data: any; error: Error | null };
  let filters: Array<[string, string]>;

  beforeEach(() => {
    jest.clearAllMocks();
    filters = [];
    result = { data: { phone: '+1 (415) 555-0100' }, error: null };
    const query: any = {
      select: () => query,
      eq: (key: string, value: string) => { filters.push([key, value]); return query; },
      maybeSingle: async () => result,
    };
    mockFrom.mockReturnValue(query);
  });

  it('allows an existing matching lead without consent but keeps both tenant and lead filters', async () => {
    await expect(assertVoiceCallAllowed('site', 'lead', phone)).resolves.toBeUndefined();
    expect(mockFrom).toHaveBeenCalledWith('leads');
    expect(filters).toEqual([['id', 'lead'], ['site_id', 'site']]);
  });

  it('still requires a lead before querying', async () => {
    await expect(assertVoiceCallAllowed('site', undefined, phone)).rejects.toMatchObject({
      status: 403, message: 'Voice calls require a lead in this site',
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects a missing or inaccessible tenant lead', async () => {
    result.data = null;
    await expect(assertVoiceCallAllowed('site', 'other-site-lead', phone)).rejects.toMatchObject({
      status: 404, message: 'Voice call lead was not found',
    });
    expect(filters).toContainEqual(['site_id', 'site']);
  });

  it('fails closed when eligibility cannot be loaded', async () => {
    result.error = new Error('Database unavailable');
    await expect(assertVoiceCallAllowed('site', 'lead', phone)).rejects.toThrow('Failed to validate Voice call eligibility');
  });

  it.each([undefined, null, '', '+14155550101'])('rejects mismatched/missing stored phone %s without implying consent is needed', async storedPhone => {
    result.data.phone = storedPhone;
    await expect(assertVoiceCallAllowed('site', 'lead', phone)).rejects.toMatchObject({
      status: 403, message: 'Voice call recipient does not match the lead phone',
    });
  });

  it.each([
    { do_not_call: true, voice_call_consent_status: 'granted' },
    { do_not_call: false, voice_call_consent_status: 'revoked' },
    { do_not_call: false, voice_call_consent_status: 'denied' },
  ])('rejects explicit server opt-outs: %j', async preferences => {
    Object.assign(result.data, preferences);
    await expect(assertVoiceCallAllowed('site', 'lead', phone)).rejects.toMatchObject({ status: 403 });
  });
});