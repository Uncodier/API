import { beforeAll, describe, expect, it, jest } from '@jest/globals';
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
let routing: typeof import('../delivery-routing');
let destinations: typeof import('../publish-destinations');
beforeAll(async () => { routing = await import('../delivery-routing'); destinations = await import('../publish-destinations'); });

const channels = { connections: [
  { id: 'wa-1', type: 'whatsapp', status: 'connected', zavu_sender_id: 'sender-1' },
  { id: 'wa-2', type: 'whatsapp', status: 'connected', zavu_sender_id: 'sender-2' },
  { id: 'email-2', type: 'email', status: 'connected', zavu_sender_id: 'email-sender' },
  { id: 'off', type: 'voice', status: 'disconnected', zavu_sender_id: 'voice' },
] };
describe('site delivery routing', () => {
  it('preserves multiple exact same-channel connections and mail/newsletter modes', () => {
    const routes = [{ channel: 'whatsapp' as const, connection_id: 'wa-2' }, { channel: 'whatsapp' as const, connection_id: 'wa-1' },
      { channel: 'email' as const, connection_id: 'email-2', audience_email_mode: 'newsletter' as const }];
    expect(routing.resolveDeliveryRoutesFromSettings(channels, { delivery_routes: routes })).toEqual(routes);
    expect(routing.resolveDeliveryAccount(channels, routes[0]).config.zavu_sender_id).toBe('sender-2');
  });
  it.each(['foreign', 'off', 'email-2'])('rejects missing/inactive/wrong-channel exact ID %s', connection_id => {
    expect(() => routing.resolveDeliveryRoutesFromSettings(channels, { channel: 'whatsapp', connection_id })).toThrow(/missing, inactive, foreign, or wrong-channel/);
  });
  it('rejects ambiguous generic channels and accepts only an unambiguous legacy selection', () => {
    expect(() => routing.resolveDeliveryRoutesFromSettings(channels, { channel: 'whatsapp' })).toThrow(/ambiguous/);
    expect(routing.resolveDeliveryRoutesFromSettings(channels, { channel: 'email' })).toEqual([{ channel: 'email', connection_id: 'email-2', audience_email_mode: 'mail' }]);
  });
  it('keeps each reserved legacy account independent and rejects disabled accounts', () => {
    const legacy = { ...channels, email: { status: 'active', email: 'smtp@example.invalid' },
      agent_email: { status: 'active', username: 'agent', domain: 'example.invalid' } };
    expect(routing.resolveDeliveryAccount(legacy, { channel: 'email', connection_id: 'legacy:email' }).provider).toBe('email');
    expect(routing.resolveDeliveryAccount(legacy, { channel: 'email', connection_id: 'legacy:agent_email' }).provider).toBe('agent_email');
    expect(() => routing.resolveDeliveryAccount({ ...legacy, email: { ...legacy.email, enabled: false } }, { channel: 'email', connection_id: 'legacy:email' })).toThrow();
  });
  it.each([
    { channel: 'email', delivery_routes: [{ channel: 'email' }] },
    { delivery_routes: [{ channel: 'sms', audience_email_mode: 'newsletter' }] },
    { delivery_routes: [{ channel: 'email', voice_mode: 'agent_call' }] },
    { delivery_routes: [{ channel: 'whatsapp', connection_id: '' }] },
    { delivery_routes: [{ channel: 'sms' }, { channel: 'sms' }] },
  ])('rejects contradictory or malformed routes %j', input => {
    expect(() => routing.parseDeliveryRoutes(input as any)).toThrow();
  });
  it('rejects duplicate identifiers in the authoritative inventory', () => {
    expect(() => routing.resolveDeliveryRoutesFromSettings({ connections: [channels.connections[0], channels.connections[0]] }, { channel: 'whatsapp', connection_id: 'wa-1' })).toThrow();
  });
  it('rejects suspended exact connections and reserved legacy aliases in the inventory', () => {
    expect(() => routing.resolveDeliveryAccount({ connections: [{ ...channels.connections[0], license_suspended: true }] },
      { channel: 'whatsapp', connection_id: 'wa-1' })).toThrow(/suspended/);
    expect(() => routing.resolveDeliveryAccount({ connections: [{ ...channels.connections[0], id: 'legacy:whatsapp' }] },
      { channel: 'whatsapp', connection_id: 'legacy:whatsapp' })).toThrow(/reserved/);
  });
});
describe('persisted publish destination contract', () => {
  it('decodes exact IDs without changing case and binds both tools over stale routing', () => {
    const values = ['mail:connection:legacy%3Aemail', 'whatsapp:connection:wa-2', 'linkedin:social:Account%3AA%2FB'];
    const result = destinations.bindPublishDestinations({ publish: { channel: 'voice', from: 'wrong', social_accounts: ['foreign'] },
      sendBulkMessages: { connection_id: 'old' } }, values);
    expect(result.social_accounts).toEqual(['Account:A/B']);
    expect(result.toolOverrides.publish).toEqual({ delivery_routes: [{ channel: 'email', audience_email_mode: 'mail', connection_id: 'legacy:email' },
      { channel: 'whatsapp', connection_id: 'wa-2' }], social_accounts: ['Account:A/B'], social_account_targets: [{ id: 'Account:A/B', network: 'linkedin' }] });
    expect(result.toolOverrides.sendBulkMessages).toEqual({ delivery_routes: result.delivery_routes });
  });
  it('model routing cannot widen a bound publish or bulk call', () => {
    expect(destinations.enforcePublishDestinationArgs({ text: 'Hello', channel: 'voice', delivery_routes: [{ channel: 'sms' }], social_accounts: ['other'], from: 'other' },
      { channel: 'email', connection_id: 'email-2' }, 'publish')).toEqual({ text: 'Hello', channel: 'email', connection_id: 'email-2' });
    expect(() => destinations.enforcePublishDestinationArgs({ channel: 'sms' }, {}, 'sendBulkMessages')).toThrow(/No saved audience/);
    expect(() => destinations.enforcePublishDestinationArgs({ instagram_dm: { conversation_id: 'other' } }, {}, 'publish')).toThrow(/not a saved publish/);
  });
  it.each(['sendEmail', 'sendWhatsApp', 'placeVoiceCall', 'whatsappTemplate', 'integration_api_request', 'webhooks', 'workflows'])('denies alternative outbound tool %s on a bound publish node', name => {
    expect(() => destinations.assertPublishNodeToolAllowed(name)).toThrow(/alternative mutation tools/);
    expect(() => destinations.assertPublishNodeToolAllowed('publish')).not.toThrow();
  });
  it.each(['whatsapp:connection:%', 'linkedin:social:', 'sms:social:x', 'linkedin:connection:x'])('fails closed on malformed persisted destinations %s', value => {
    expect(() => destinations.parsePublishDestinations([value])).toThrow();
  });
});