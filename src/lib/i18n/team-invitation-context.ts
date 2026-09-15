export interface TeamInvitationContext {
  siteName: string;
  inviterName?: string;
  role?: string;
}

type Metadata = Record<string, unknown>;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function resolveTeamInvitationContext(
  redirectTo: string | undefined,
  metadata: Metadata
): TeamInvitationContext | undefined {
  let query: URLSearchParams | undefined;

  if (redirectTo) {
    try {
      query = new URL(redirectTo).searchParams;
    } catch {
      // Ignore malformed redirect URLs and fall back to user metadata.
    }
  }

  const invitationType =
    query?.get('invitationType') ||
    stringValue(metadata.invitation_type) ||
    stringValue(metadata.invitationType);

  if (invitationType !== 'team_invitation') return undefined;

  const siteName =
    query?.get('siteName') ||
    stringValue(metadata.site_name) ||
    stringValue(metadata.siteName);

  if (!siteName) return undefined;

  return {
    siteName,
    inviterName:
      query?.get('inviterName') ||
      stringValue(metadata.inviter_name) ||
      stringValue(metadata.inviterName),
    role: query?.get('role') || stringValue(metadata.role),
  };
}
