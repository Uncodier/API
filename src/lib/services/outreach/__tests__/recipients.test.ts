import { availableOutreachRecipients, resolveOutreachRecipient } from '../recipients';
import { getOutreachPolicy, isOutreachChannel, selectedOutreachAccounts, selectedOutreachChannels } from '../policy';
const activity = 'leads_initial_cold_outreach';
const lead = { id: 'lead', site_id: 'site', phone: '+15551234567', email: 'lead@example.com' };
const resolve = (channel: string, extra: any = {}, conversations: any[] = []) => resolveOutreachRecipient({ siteId: 'site', lead: { ...lead, ...extra }, channel, conversations });
const conversation = (channel: string, custom_data: any) => ({ id: 'conversation', site_id: 'site', lead_id: 'lead', channel, custom_data });

test.each(['sms', 'telegram', 'messenger', 'instagram', 'voice', 'custom_chat'])('dynamic %s selected accounts retain email/whatsapp defaults and exact type', channel => {
  const settings = { activities: { [activity]: { channel_accounts: { [channel]: ['selected'] } } }, channels: { connections: [
    { id: 'first', type: channel, status: 'connected', zavu_sender_id: 'first-sender' },
    { id: 'selected', type: channel, status: 'connected', zavu_sender_id: 'chosen-sender' },
  ] } };
  const policy = getOutreachPolicy(settings, activity)!;
  expect(policy.channel_accounts).toEqual({ email: [], whatsapp: [], [channel]: ['selected'] });
  expect(selectedOutreachChannels(settings, policy)).toEqual([channel]);
  expect(selectedOutreachAccounts(settings, policy, channel)[0].config.zavu_sender_id).toBe('chosen-sender');
  settings.channels.connections[1].type = 'other';
  expect(selectedOutreachAccounts(settings, policy, channel)).toEqual([]);
  settings.channels.connections.push({ id: 'selected', type: channel, status: 'connected', zavu_sender_id: 'duplicate' });
  expect(selectedOutreachAccounts(settings, policy, channel)).toEqual([]);
});
test.each(['__proto__', 'prototype', 'constructor', 'toString', 'Telegram', 'bad key', 'x'.repeat(65), 'audio'])('reject unsafe/reserved channel %s', key => {
  expect(isOutreachChannel(key)).toBe(false);
  expect(getOutreachPolicy({ activities: { [activity]: { channel_accounts: JSON.parse(`{"${key}":["sender"]}`) } } }, activity)).toBeNull();
});
test('legacy WhatsApp account cannot authorize another arbitrary channel', () => {
  const settings = { channels: { whatsapp: { status: 'active', account_sid: 'ac', existingNumber: '+15551234567' } } };
  const policy = getOutreachPolicy({ activities: { [activity]: { channel_accounts: { telegram: ['whatsapp'] } } } }, activity)!;
  expect(selectedOutreachAccounts(settings, policy, 'telegram')).toEqual([]);
});
test.each(['sms', 'whatsapp', 'voice'])('%s only uses valid E164 lead phone', channel => {
  expect(resolve(channel)?.recipient).toBe(lead.phone);
  expect(resolve(channel, { phone: '123456789' })).toBeUndefined();
});
test.each(['telegram', 'messenger', 'instagram', 'custom_chat'])('%s never treats generic phone as channel recipient', channel => {
  expect(resolve(channel)).toBeUndefined();
  expect(resolve(channel, { origin: channel })).toBeUndefined();
  expect(resolve(channel, {}, [conversation(channel, {})])).toBeUndefined();
  expect(resolve(channel, { social_networks: { [channel]: { chat_id: 'direct-user' } } })?.recipient).toBe('direct-user');
  expect(resolve(channel, { social_networks: { [channel]: '@direct_user' } })?.recipient).toBe('@direct_user');
});
test('conversation identity requires same tenant lead channel, excludes public/social and wrong-channel identities', () => {
  const c = conversation('telegram', { chat_id: '1234567' });
  expect(resolve('telegram', {}, [c])).toMatchObject({ recipient: '1234567', source: 'conversation', conversationId: c.id });
  for (const bad of [{ ...c, site_id: 'other' }, { ...c, lead_id: 'other' }, { ...c, channel: 'instagram' },
    { ...c, custom_data: { ...c.custom_data, channel: 'instagram' } },
    { ...c, custom_data: { ...c.custom_data, source: 'social_comment' } },
    { ...c, custom_data: { ...c.custom_data, outstand_conversation_id: 'outstand-id' } }]) {
    expect(resolve('telegram', {}, [bad])).toBeUndefined();
  }
});
test('nested known identity accepted but generic conversation id and sender id are not recipients', () => {
  expect(resolve('telegram', {}, [conversation('telegram', { identities: { telegram: { user_id: 'user-1' } } })])?.recipient).toBe('user-1');
  expect(resolve('telegram', {}, [conversation('telegram', { id: 'db-id', sender_id: 'agent-id', conversation_id: 'provider-thread' })])).toBeUndefined();
});
test.each(['https://t.me/user', '../path', 'with space', 'user\nname', 'a'.repeat(129), '+15551234567'])('unsafe platform identity %j refused', identity => {
  expect(resolve('telegram', { social_networks: { telegram: identity } })).toBeUndefined();
});
test('legacy webhook identity requires exact origin, not empty generated conversation', () => {
  expect(resolve('telegram', { phone: '1234567', origin: 'telegram' })).toMatchObject({ recipient: '1234567', source: 'legacy_origin' });
  expect(resolve('instagram', { phone: '1234567', origin: 'telegram' })).toBeUndefined();
  expect(resolve('telegram', { phone: '1234567' }, [conversation('telegram', {})])).toBeUndefined();
});
test('social comment lead handle cannot be reinterpreted as direct Instagram recipient', () => {
  const social = { social_networks: { instagram: 'commenter' } };
  const comment = conversation('instagram', { source: 'comment', platform_comment_id: 'comment-1' });
  expect(resolve('instagram', social, [comment])).toBeUndefined();
  expect(resolve('instagram', { ...social, metadata: { social_network: 'instagram', social_handle: 'commenter' } })).toBeUndefined();
  expect(resolve('instagram', social, [comment, conversation('instagram', { recipient_id: 'direct-user' })])?.recipient).toBe('direct-user');
});
test('voice accepts absent/unknown consent and invalid timestamps, but not explicit opt-outs', () => {
  for (const allowed of [{}, { voice_call_consent_status: 'unknown' }, { voice_call_consent_status: 'granted' },
    { voice_call_consent_status: 'granted', voice_call_consent_at: 'invalid' }]) {
    expect(resolve('voice', allowed)?.recipient).toBe(lead.phone);
  }
  for (const optedOut of [{ do_not_call: true, voice_call_consent_status: 'granted' },
    { voice_call_consent_status: 'revoked' }, { voice_call_consent_status: 'denied' }]) {
    expect(resolve('voice', optedOut)).toBeUndefined();
    expect(resolve('sms', optedOut)?.recipient).toBe(lead.phone);
  }
  expect(resolve('voice', { site_id: 'other-site' })).toBeUndefined();
  expect(Object.keys(availableOutreachRecipients({ siteId: 'site', lead, channels: ['sms', 'voice', 'telegram'] }))).toEqual(['sms', 'voice']);
});