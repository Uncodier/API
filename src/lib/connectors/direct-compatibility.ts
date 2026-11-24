// Necessary live executor checks, not authorization to execute any action.
export const acceptsDirectToolkit = (kit: { toolkit_type: string | null; enabled: boolean | null }) =>
  kit.toolkit_type === 'api' && kit.enabled !== false;

export const acceptsDirectAccount = (account: { accountType?: string; oauth2: boolean; apiKeyAuth: boolean }) =>
  account.accountType === 'PRIVATE' && (account.oauth2 || account.apiKeyAuth);
