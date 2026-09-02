export function resolveAuthEmailChannel(emailData: {
  redirect_to?: string;
  email_action_type?: string;
}): 'otp' | 'link' {
  if (emailData.email_action_type === 'reauthentication') {
    return 'otp';
  }

  const redirectTo = emailData.redirect_to || '';

  if (redirectTo.includes('auth_channel=otp') || redirectTo.includes('/shop/')) {
    return 'otp';
  }

  // Shop on www often sends emailRedirectTo that GoTrue drops because
  // makinari.com is not in Redirect URLs. The webhook then only has Site URL.
  if (emailData.email_action_type === 'magiclink' && isBareSiteRedirect(redirectTo)) {
    return 'otp';
  }

  return 'link';
}

function isBareSiteRedirect(redirectTo: string): boolean {
  if (!redirectTo) return true;
  try {
    const url = new URL(redirectTo);
    const path = url.pathname.replace(/\/$/, '');
    return !path && url.search === '';
  } catch {
    return false;
  }
}
