export function resolveAuthEmailChannel(emailData: {
  redirect_to?: string;
  email_action_type?: string;
}): 'otp' | 'link' {
  if (emailData.email_action_type === 'reauthentication') {
    return 'otp';
  }

  if (emailData.redirect_to) {
    if (emailData.redirect_to.includes('auth_channel=otp')) {
      return 'otp';
    }
    // Fallback if the query param was stripped but we are in shop flow
    if (emailData.redirect_to.includes('/shop/')) {
      return 'otp';
    }
  }

  return 'link';
}
