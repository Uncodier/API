import { generateAuthEmailContent } from '@/lib/i18n/auth-email-template';
import { resolveTeamInvitationContext } from '@/lib/i18n/team-invitation-context';

describe('team invitation emails', () => {
  it('reads invitation context from the frontend redirect URL', () => {
    const context = resolveTeamInvitationContext(
      'https://app.makinari.com/api/auth/callback?invitationType=team_invitation&siteName=Market+Fit&role=create&inviterName=Ada',
      {}
    );

    expect(context).toEqual({
      siteName: 'Market Fit',
      role: 'create',
      inviterName: 'Ada',
    });
  });

  it('supports both camelCase and snake_case metadata', () => {
    expect(
      resolveTeamInvitationContext(undefined, {
        invitationType: 'team_invitation',
        siteName: 'Camel Project',
      })
    ).toMatchObject({ siteName: 'Camel Project' });

    expect(
      resolveTeamInvitationContext(undefined, {
        invitation_type: 'team_invitation',
        site_name: 'Snake Project',
      })
    ).toMatchObject({ siteName: 'Snake Project' });
  });

  it('turns a magic link into a contextual team invitation email', () => {
    const content = generateAuthEmailContent({
      locale: 'es',
      actionType: 'magiclink',
      channel: 'link',
      confirmUrl: 'https://app.makinari.com/auth/confirm?token_hash=secret',
      siteName: 'Market Fit',
      teamInvitation: {
        siteName: 'Market Fit',
        inviterName: 'Ada',
        role: 'create',
      },
    });

    expect(content.subject).toBe('Invitación a Market Fit');
    expect(content.text).toContain('Ada te invitó a colaborar en Market Fit.');
    expect(content.text).toContain('Rol: Editor');
    expect(content.text).toContain('Aceptar invitación:');
    expect(content.html).toContain('Market Fit');
  });
});
