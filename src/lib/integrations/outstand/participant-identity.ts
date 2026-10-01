import type { OutstandConversation } from './types';

export interface OutstandParticipantIdentity {
  participantId: string;
  socialAccountId: string;
  displayName: string;
  username: string;
  profilePicture: string;
}

export class OutstandParticipantIdentityError extends Error {
  readonly status = 503;

  constructor() {
    super('Unable to reconcile Outstand participant identity');
    this.name = 'OutstandParticipantIdentityError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function name(value: unknown): string {
  const candidate = text(value);
  return /^(?:visitor|social user|instagram contact|unknown|anonymous)$/i.test(candidate)
    || /^(?:https?:\/\/|urn:)/i.test(candidate) || /^\d+$/.test(candidate) ? '' : candidate;
}

function username(value: unknown): string {
  const candidate = text(value).replace(/^@/, '');
  return /^[a-z\d_.]{1,30}$/i.test(candidate) && !/^(unknown|anonymous)$/i.test(candidate)
    ? candidate : '';
}

function picture(value: unknown): string {
  const candidate = text(value);
  return /^https:\/\//i.test(candidate) ? candidate : '';
}

/** Only participant fields identify the sender. metadata.platformAccountId is OUR account. */
export function outstandParticipantIdentity(
  conversation: OutstandConversation,
  previous: Record<string, unknown> = {},
): OutstandParticipantIdentity {
  const participantId = text(conversation.participantId);
  const socialAccountId = text(conversation.socialAccountId);
  if (conversation.network !== 'instagram' || !text(conversation.id) || !participantId || !socialAccountId
    || participantId === socialAccountId || participantId === text(conversation.metadata?.platformAccountId)
    || (previous.outstand_participant_id && previous.outstand_participant_id !== participantId)
    || (previous.outstand_social_account_id && previous.outstand_social_account_id !== socialAccountId)) {
    throw new OutstandParticipantIdentityError();
  }

  // A partial provider refresh must not erase an already known participant.
  return {
    participantId,
    socialAccountId,
    displayName: name(conversation.participantDisplayName) || name(previous.participant_display_name),
    username: username(conversation.participantUsername) || username(previous.participant_username),
    profilePicture: picture(conversation.participantProfilePicture) || picture(previous.participant_profile_picture),
  };
}