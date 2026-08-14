import {
  accountSidFromTwilioMediaUrl,
  fetchTwilioMedia,
  isTwilioMediaUrl,
  replaceTwilioMediaUrls,
  resolveTwilioMediaAuth,
} from '../fetchTwilioMedia';

describe('fetchTwilioMedia helpers', () => {
  const originalFetch = global.fetch;
  const originalSid = process.env.GEAR_TWILIO_ACCOUNT_SID;
  const originalToken = process.env.GEAR_TWILIO_AUTH_TOKEN;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalSid === undefined) delete process.env.GEAR_TWILIO_ACCOUNT_SID;
    else process.env.GEAR_TWILIO_ACCOUNT_SID = originalSid;
    if (originalToken === undefined) delete process.env.GEAR_TWILIO_AUTH_TOKEN;
    else process.env.GEAR_TWILIO_AUTH_TOKEN = originalToken;
  });

  it('detects Twilio media URLs', () => {
    expect(
      isTwilioMediaUrl(
        'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages/MM1/Media/ME1'
      )
    ).toBe(true);
    expect(isTwilioMediaUrl('https://cdn.example.com/photo.jpg')).toBe(false);
  });

  it('parses Account SID from the media URL', () => {
    expect(
      accountSidFromTwilioMediaUrl(
        'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages/MM1/Media/ME1'
      )
    ).toBe('ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('resolves auth from URL SID + env token', () => {
    const auth = resolveTwilioMediaAuth(
      'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages/MM1/Media/ME1',
      {},
      { GEAR_TWILIO_AUTH_TOKEN: 'token' }
    );
    expect(auth).toEqual({
      accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      authToken: 'token',
    });
  });

  it('replaces original Twilio URLs with uploaded public URLs', () => {
    const text = 'See https://api.twilio.com/media/1';
    const next = replaceTwilioMediaUrls(
      text,
      [{ url: 'https://api.twilio.com/media/1' }],
      [{ url: 'https://cdn.example.com/1.jpg' }]
    );
    expect(next).toBe('See https://cdn.example.com/1.jpg');
  });

  it('follows Twilio redirect without forwarding Authorization', async () => {
    const twilioUrl =
      'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages/MM1/Media/ME1';
    const s3Url = 'https://s3.amazonaws.com/bucket/file.jpg';
    const body = Buffer.from('bytes');

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 307,
        headers: new Headers({ location: s3Url }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => body,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
      });

    const result = await fetchTwilioMedia(
      twilioUrl,
      { accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', authToken: 'token' }
    );

    expect(Buffer.from(result.buffer).toString()).toBe('bytes');
    expect(result.contentType).toBe('image/jpeg');
    const firstInit = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(firstInit.redirect).toBe('manual');
    expect(firstInit.headers.get('Authorization')).toMatch(/^Basic /);
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toBeUndefined();
  });
});
