import { ensureLocalOutstandConversation } from '../inbox-sync';
import { outstandParticipantIdentity, OutstandParticipantIdentityError } from '../participant-identity';
import { inboxIdentityDatabase } from './inbox-identity-database';
import type { OutstandConversation } from '../types';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../client', () => ({ getOutstandClient: jest.fn(() => { throw new Error('No provider calls allowed'); }) }));

const conversation: OutstandConversation = {
  id: 'dm-1', orgId: 'org-1', socialAccountId: 'account-1', network: 'instagram',
  platformConversationId: 'igsid-1', participantId: 'igsid-1', participantDisplayName: 'Alice Smith',
  participantUsername: 'alice.smith', participantProfilePicture: 'https://example.com/avatar.jpg',
  lastMessageAt: '2026-09-25T21:21:09.256Z', lastInboundAt: '2026-09-25T21:21:09.256Z',
  unreadCount: 1, status: 'active', metadata: { platformAccountId: 'owned-platform-id' },
  createdAt: '2026-09-25T21:21:09.256Z', updatedAt: '2026-09-25T21:21:09.256Z',
};
const sync = (patch: Partial<OutstandConversation> = {}, siteId = 'site-1') =>
  ensureLocalOutstandConversation({ ...conversation, ...patch }, siteId);

describe('Outstand DM participant identity', () => {
  it('links a new conversation with the real participant, not the publishing account', async () => {
    const db = inboxIdentityDatabase();
    const id = await sync();
    expect(db.tables.leads).toHaveLength(1);
    expect(db.tables.leads[0]).toMatchObject({ name: 'Alice Smith', origin: 'instagram', social_networks: { instagram: 'alice.smith' },
      metadata: { source: 'outstand_dm', outstand_dm_participant_id: 'igsid-1', outstand_dm_social_account_id: 'account-1' } });
    expect(db.tables.conversations[0]).toMatchObject({ id, lead_id: db.tables.leads[0].id, title: 'Alice Smith',
      custom_data: { participant_display_name: 'Alice Smith', participant_username: 'alice.smith', participant_identity_status: 'available' } });
    expect(JSON.stringify(db.tables)).not.toContain('owned-platform-id');
  });

  it('uses explicit handles, including numeric usernames, but never guesses one from a name or account metadata', async () => {
    const db = inboxIdentityDatabase();
    await sync({ participantDisplayName: null, participantUsername: '@12345' });
    expect(db.tables.leads[0].name).toBe('12345');
    const identity = outstandParticipantIdentity({ ...conversation, participantUsername: undefined,
      metadata: { username: 'pigs-owned-account', name: 'Pigs', platformAccountId: 'owned-platform-id' } });
    expect(identity.username).toBe('');
    expect(identity.displayName).toBe('Alice Smith');
  });

  it('creates an honestly unnamed contact and later enriches only its generated name', async () => {
    const db = inboxIdentityDatabase();
    const id = await sync({ participantDisplayName: null, participantUsername: undefined, participantProfilePicture: null });
    const leadId = db.tables.leads[0].id;
    expect(db.tables.leads[0]).toMatchObject({ name: 'Instagram contact', metadata: { outstand_dm_identity_status: 'unavailable' } });
    expect(db.tables.leads[0]).not.toHaveProperty('social_networks');
    expect(await sync()).toBe(id);
    expect(db.tables.leads).toHaveLength(1);
    expect(db.tables.leads[0]).toMatchObject({ id: leadId, name: 'Alice Smith' });
  });

  it('repairs an existing unlinked DM without importing or sending messages', async () => {
    const db = inboxIdentityDatabase();
    db.tables.conversations.push({ id: 'historical', site_id: 'site-1', channel: 'instagram', lead_id: null,
      title: 'Instagram direct message', custom_data: { source: 'outstand_dm', outstand_conversation_id: 'dm-1',
        outstand_participant_id: 'igsid-1', outstand_social_account_id: 'account-1', participant_display_name: null, keep: true } });
    expect(await sync()).toBe('historical');
    expect(db.tables.conversations[0]).toMatchObject({ lead_id: db.tables.leads[0].id, title: 'Alice Smith', custom_data: { keep: true } });
    expect(db.operations.every(op => ['sites', 'leads', 'conversations'].includes(op.table))).toBe(true);
  });

  it('preserves known fields and generated names across null or placeholder provider refreshes', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    await sync({ participantDisplayName: 'Social User', participantUsername: null, participantProfilePicture: null });
    expect(db.tables.conversations[0]).toMatchObject({ title: 'Alice Smith', custom_data: {
      participant_display_name: 'Alice Smith', participant_username: 'alice.smith', participant_profile_picture: 'https://example.com/avatar.jpg',
    } });
    expect(db.tables.leads[0].name).toBe('Alice Smith');
  });

  it('deduplicates repeated and simultaneous first-seen conversations for one scoped participant', async () => {
    const db = inboxIdentityDatabase();
    const ids = await Promise.all([sync(), sync(), sync({ id: 'dm-2' })]);
    expect(ids[0]).toBe(ids[1]);
    expect(db.tables.leads).toHaveLength(1);
    expect(db.tables.conversations).toHaveLength(2);
    expect(new Set(db.tables.conversations.map(row => row.lead_id)).size).toBe(1);
  });

  it('preserves the available profile when a simultaneous null refresh arrives', async () => {
    const db = inboxIdentityDatabase();
    await Promise.all([sync(), sync({ participantDisplayName: null, participantUsername: null, participantProfilePicture: null })]);
    expect(db.tables.leads).toHaveLength(1);
    expect(db.tables.leads[0].name).toBe('Alice Smith');
    expect(db.tables.conversations).toHaveLength(1);
    expect(db.tables.conversations[0].custom_data).toMatchObject({
      participant_display_name: 'Alice Smith', participant_username: 'alice.smith', participant_identity_status: 'available',
    });
  });

  it('isolates identities across site, publishing account and participant even if names match', async () => {
    const db = inboxIdentityDatabase();
    db.tables.sites.push({ id: 'site-2', user_id: 'owner-2' });
    await sync();
    await sync({}, 'site-2');
    await sync({ id: 'dm-2', socialAccountId: 'account-2' });
    await sync({ id: 'dm-3', participantId: 'igsid-2' });
    expect(db.tables.leads).toHaveLength(4);
    expect(new Set(db.tables.leads.map(row => row.id)).size).toBe(4);
  });

  it('never equates a public comment ID/handle with the Instagram DM IGSID', async () => {
    const db = inboxIdentityDatabase();
    db.tables.leads.push({ id: 'commenter', site_id: 'site-1', origin: 'instagram', name: 'Commenter',
      metadata: { social_author_id: 'igsid-1', social_account_id: 'account-1', social_handle: 'alice.smith' } });
    await sync();
    expect(db.tables.leads).toHaveLength(2);
    expect(db.tables.conversations[0].lead_id).not.toBe('commenter');
  });

  it('preserves manually edited contact name, handle, title and unrelated metadata', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    Object.assign(db.tables.leads[0], { name: 'VIP customer', social_networks: { instagram: 'manual', facebook: 'keep' } });
    Object.assign(db.tables.leads[0].metadata, { unrelated: true });
    db.tables.conversations[0].title = 'Refund discussion';
    await sync({ participantDisplayName: 'New provider name', participantUsername: 'new.handle' });
    expect(db.tables.leads[0]).toMatchObject({ name: 'VIP customer', social_networks: { instagram: 'manual', facebook: 'keep' }, metadata: { unrelated: true } });
    expect(db.tables.conversations[0].title).toBe('Refund discussion');
  });

  it('honors an explicitly linked CRM contact in the same site without replacing its manual identity', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    const id = db.tables.leads[0].id;
    Object.assign(db.tables.leads[0], { name: 'Manual lead', origin: 'website', metadata: { source: 'form', keep: true } });
    await sync();
    expect(db.tables.leads).toHaveLength(1);
    expect(db.tables.leads[0]).toMatchObject({ name: 'Manual lead', origin: 'website', metadata: { source: 'form', keep: true } });
    expect(db.tables.conversations[0].lead_id).toBe(id);
  });

  it('preserves a relink to a different CRM lead without duplicating the canonical DM tuple', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    const automaticId = db.tables.leads[0].id;
    const manual = { id: 'crm-lead', site_id: 'site-1', name: 'Manually linked', metadata: { source: 'form' } };
    db.tables.leads.push(manual);
    db.tables.conversations[0].lead_id = manual.id;
    await sync();
    expect(manual).toEqual({ id: 'crm-lead', site_id: 'site-1', name: 'Manually linked', metadata: { source: 'form' } });
    expect(db.tables.conversations[0].lead_id).toBe(manual.id);
    await sync({ id: 'another-dm' });
    expect(db.tables.conversations[1].lead_id).toBe(automaticId);
    expect(db.tables.leads).toHaveLength(2);
  });

  it('does not roll the canonical identity back using another conversation cache on a null refresh', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    await sync({ id: 'another-dm' });
    await sync({ participantDisplayName: 'Fresh name', participantUsername: 'fresh.handle', participantProfilePicture: 'https://example.com/fresh.jpg' });
    await sync({ id: 'another-dm', participantDisplayName: null, participantUsername: null, participantProfilePicture: null });
    expect(db.tables.leads[0]).toMatchObject({ name: 'Fresh name', social_networks: { instagram: 'fresh.handle' } });
    expect(db.tables.conversations[1].custom_data).toMatchObject({ participant_display_name: 'Fresh name',
      participant_username: 'fresh.handle', participant_profile_picture: 'https://example.com/fresh.jpg' });
  });

  it('preserves a fresh lead while a null refresh races between the lead and conversation writes', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    let paused = false;
    let release!: () => void;
    let notify!: () => void;
    const ready = new Promise<void>(resolve => { notify = resolve; });
    const resumed = new Promise<void>(resolve => { release = resolve; });
    db.before = async op => {
      if (op.table === 'conversations' && op.action === 'update' && !paused) {
        paused = true;
        notify();
        await resumed;
      }
    };
    const fresh = sync({ participantDisplayName: 'Fresh name', participantUsername: 'fresh.handle' });
    await ready;
    await sync({ participantDisplayName: null, participantUsername: null });
    release();
    await fresh;
    expect(db.tables.leads[0]).toMatchObject({ name: 'Fresh name', social_networks: { instagram: 'fresh.handle' } });
    expect(db.tables.conversations[0].custom_data).toMatchObject({ participant_display_name: 'Fresh name', participant_username: 'fresh.handle' });
  });

  it.each(['participantId', 'socialAccountId'] as const)('rejects missing %s without making a generic lead', async field => {
    const db = inboxIdentityDatabase();
    await expect(sync({ [field]: '' })).rejects.toBeInstanceOf(OutstandParticipantIdentityError);
    expect(db.tables.leads).toHaveLength(0);
  });

  it.each([
    { participantId: 'owned-platform-id' }, { network: 'facebook' },
    { participantId: 'account-1' },
  ])('rejects invalid/owned participant identity %j', async patch => {
    const db = inboxIdentityDatabase();
    await expect(sync(patch as Partial<OutstandConversation>)).rejects.toBeInstanceOf(OutstandParticipantIdentityError);
    expect(db.tables.leads).toHaveLength(0);
  });

  it('fails closed on conflicting participant/account references and cross-site CRM links', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    await expect(sync({ participantId: 'someone-else' })).rejects.toBeInstanceOf(OutstandParticipantIdentityError);
    await expect(sync({ socialAccountId: 'another-account' })).rejects.toBeInstanceOf(OutstandParticipantIdentityError);
    db.tables.leads[0].site_id = 'another-site';
    await expect(sync()).rejects.toBeInstanceOf(OutstandParticipantIdentityError);
    expect(db.tables.leads).toHaveLength(1);
  });

  it.each(['leads:read', 'leads:insert', 'sites:read', 'conversations:read'])('stops on %s rather than silently creating fallback duplicates', async fail => {
    const db = inboxIdentityDatabase();
    db.fail = fail;
    await expect(sync()).rejects.toBeDefined();
    expect(db.tables.leads).toHaveLength(0);
    expect(db.tables.conversations).toHaveLength(0);
  });

  it('recovers after a conversation write fails without creating another lead', async () => {
    const db = inboxIdentityDatabase();
    db.fail = 'conversations:insert';
    await expect(sync()).rejects.toBeDefined();
    db.fail = '';
    await sync();
    expect(db.tables.leads).toHaveLength(1);
    expect(db.tables.conversations).toHaveLength(1);
  });

  it('rejects ambiguous existing participant matches', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    db.tables.leads.push({ ...db.tables.leads[0], id: 'duplicate' });
    await expect(sync({ id: 'new-dm' })).rejects.toBeInstanceOf(OutstandParticipantIdentityError);
    expect(db.tables.leads).toHaveLength(2);
  });

  it.each([
    { outstand_dm_participant_id: 'different-participant' },
    { outstand_dm_social_account_id: 'different-account' },
  ])('does not rebind a conflicting linked contact %j', async conflict => {
    const db = inboxIdentityDatabase();
    await sync();
    Object.assign(db.tables.leads[0].metadata, conflict);
    const before = JSON.stringify(db.tables);
    await expect(sync()).rejects.toMatchObject({ status: 503 });
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it('does not link/update the conversation after a lead refresh fails', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    const before = JSON.stringify(db.tables);
    db.fail = 'leads:update';
    await expect(sync({ participantDisplayName: 'Changed' })).rejects.toMatchObject({ status: 503 });
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it('fails rather than overwriting when conditional updates keep losing the race', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    let version = 0;
    db.before = op => {
      if (op.action === 'update' && op.table === 'leads') db.tables.leads[0].metadata.version = ++version;
    };
    await expect(sync({ participantDisplayName: 'Changed' })).rejects.toMatchObject({ status: 503 });
    expect(db.tables.leads).toHaveLength(1);
    expect(db.tables.leads[0].name).toBe('Alice Smith');
    expect(db.tables.conversations[0].title).toBe('Alice Smith');
  });

  it('reloads and preserves a concurrent manual lead/title edit', async () => {
    const db = inboxIdentityDatabase();
    await sync();
    let leadEdited = false, titleEdited = false;
    db.before = op => {
      if (op.action !== 'update') return;
      if (op.table === 'leads' && !leadEdited) { db.tables.leads[0].name = 'Concurrent manual name'; leadEdited = true; }
      if (op.table === 'conversations' && !titleEdited) { db.tables.conversations[0].title = 'Concurrent title'; titleEdited = true; }
    };
    await sync({ participantDisplayName: 'Provider refresh' });
    expect(db.tables.leads[0].name).toBe('Concurrent manual name');
    expect(db.tables.conversations[0].title).toBe('Concurrent title');
  });
});